const express = require("express");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function safeLike(q) {
  return `%${String(q || "").trim().toLowerCase()}%`;
}

function tokenizeQuery(q) {
  const raw = String(q || "").toLowerCase();
  const parts = raw
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function getEditorEmails() {
  const envEmails = String(process.env.EDITOR_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const dbEmails = db.prepare("SELECT email FROM editor_emails WHERE status='ACTIVE'").all().map((r) => r.email);
  return new Set([...envEmails, ...dbEmails]);
}

function canEditEmail(email) {
  if (!email) return false;
  return getEditorEmails().has(String(email).trim().toLowerCase());
}

function extractFolderId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/i);
  if (m && m[1]) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

function getDriveFolderInfo() {
  const envFolder = extractFolderId(process.env.DRIVE_FOLDER_ID);
  const doc = db.prepare("SELECT name, url_drive, drive_folder_id FROM documents WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get();
  if (!doc && !envFolder) return null;

  const folderId = envFolder || extractFolderId(doc?.drive_folder_id) || extractFolderId(doc?.url_drive);
  if (!folderId) {
    return {
      name: doc?.name || "Inventario",
      folder_id: null,
      url_drive: doc?.url_drive || null,
    };
  }

  return {
    name: doc?.name || "Inventario",
    folder_id: folderId,
    url_drive: `https://drive.google.com/drive/folders/${folderId}`,
  };
}

router.get("/document", requireAuth, (req, res) => {
  const info = getDriveFolderInfo();
  if (!info) return res.status(404).json({ message: "No hay documento activo" });
  res.json({ name: info.name, url_drive: info.url_drive, folder_id: info.folder_id });
});

router.get("/drive-folder", requireAuth, (req, res) => {
  const info = getDriveFolderInfo();
  if (!info || !info.url_drive) return res.status(404).json({ message: "No hay carpeta de Drive configurada" });
  res.json({ folder_id: info.folder_id, url: info.url_drive, name: info.name });
});

router.get("/permissions", requireAuth, (req, res) => {
  res.json({ can_edit: canEditEmail(req.user?.email) });
});

router.get("/files", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, drive_url, cabinet, file_date
    FROM files
    WHERE status='ACTIVE'
    ORDER BY id DESC
  `).all();
  res.json(rows);
});

router.get("/sectors", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT sector
    FROM (
      SELECT trim(COALESCE(location, '')) AS sector FROM entries
      UNION
      SELECT trim(COALESCE(cabinet, '')) AS sector FROM files
    )
    WHERE sector <> ''
    ORDER BY sector ASC
  `).all();
  res.json(rows.map((r) => r.sector));
});

router.get("/suggest", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);

  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT suggestion
    FROM (
      SELECT trim(COALESCE(e.location, '')) AS suggestion
      FROM entries e
      WHERE lower(COALESCE(e.location, '')) LIKE ?
      UNION
      SELECT trim(COALESCE(f.cabinet, '')) AS suggestion
      FROM files f
      WHERE lower(COALESCE(f.cabinet, '')) LIKE ?
      UNION
      SELECT trim(COALESCE(f.title, '')) AS suggestion
      FROM files f
      WHERE lower(COALESCE(f.title, '')) LIKE ?
      UNION
      SELECT trim(substr(COALESCE(e.description, ''), 1, 80)) AS suggestion
      FROM entries e
      WHERE lower(COALESCE(e.description, '')) LIKE ?
    )
    WHERE suggestion <> ''
    ORDER BY suggestion ASC
    LIMIT 12
  `).all(like, like, like, like);

  res.json(rows.map((r) => r.suggestion));
});

router.post("/files", requireAuth, requireRole("ADMIN"), (req, res) => {
  const { title, drive_url, cabinet, file_date } = req.body || {};
  if (!title || !drive_url) return res.status(400).json({ message: "title y drive_url son obligatorios" });

  const info = db.prepare(`
    INSERT INTO files (title, drive_url, cabinet, file_date, status)
    VALUES (?, ?, ?, ?, 'ACTIVE')
  `).run(
    String(title).trim(),
    String(drive_url).trim(),
    cabinet ? String(cabinet).trim() : null,
    file_date ? String(file_date).trim() : null
  );

  res.json({ id: info.lastInsertRowid });
});

router.post("/entries", requireAuth, (req, res) => {
  const { file_id, description, keywords, location, ref_date } = req.body || {};
  if (!description || !String(description).trim()) {
    return res.status(400).json({ message: "La descripcion es obligatoria" });
  }

  if (file_id) {
    const file = db.prepare("SELECT id FROM files WHERE id=? AND status='ACTIVE'").get(file_id);
    if (!file) return res.status(400).json({ message: "file_id no existe o esta inactivo" });
  }

  const info = db.prepare(`
    INSERT INTO entries (file_id, description, keywords, location, ref_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    file_id || null,
    String(description).trim(),
    keywords ? String(keywords).trim() : null,
    location ? String(location).trim() : null,
    ref_date ? String(ref_date).trim() : null,
    req.user.id
  );

  res.json({ id: info.lastInsertRowid });
});

router.get("/search", requireAuth, (req, res) => {
  const { q, cabinet, from, to, file_id } = req.query;
  const where = ["1=1"];
  const params = [];
  const scoreParts = ["0"];
  const scoreParams = [];

  if (q && String(q).trim()) {
    const phrase = String(q).trim().toLowerCase();
    const phrasePrefix = `${phrase}%`;
    const tokens = tokenizeQuery(q);
    const orderedPattern = tokens.length ? `%${tokens.join("%")}%` : safeLike(phrase);
    const perTokenClauses = [];

    // Strict priority: exact phrase match first.
    scoreParts.push("CASE WHEN lower(trim(COALESCE(f.cabinet, ''))) = ? THEN 20000 ELSE 0 END");
    scoreParams.push(phrase);
    scoreParts.push("CASE WHEN lower(trim(COALESCE(e.location, ''))) = ? THEN 18000 ELSE 0 END");
    scoreParams.push(phrase);
    scoreParts.push("CASE WHEN lower(trim(COALESCE(f.title, ''))) = ? THEN 16000 ELSE 0 END");
    scoreParams.push(phrase);
    scoreParts.push("CASE WHEN lower(trim(e.description)) = ? THEN 14000 ELSE 0 END");
    scoreParams.push(phrase);

    // Secondary strict priority: starts with phrase.
    scoreParts.push("CASE WHEN lower(COALESCE(f.cabinet, '')) LIKE ? THEN 1200 ELSE 0 END");
    scoreParams.push(phrasePrefix);
    scoreParts.push("CASE WHEN lower(COALESCE(e.location, '')) LIKE ? THEN 1000 ELSE 0 END");
    scoreParams.push(phrasePrefix);
    scoreParts.push("CASE WHEN lower(COALESCE(f.title, '')) LIKE ? THEN 850 ELSE 0 END");
    scoreParams.push(phrasePrefix);

    scoreParts.push("CASE WHEN lower(COALESCE(f.cabinet, '')) LIKE ? THEN 220 ELSE 0 END");
    scoreParams.push(safeLike(phrase));
    scoreParts.push("CASE WHEN lower(COALESCE(e.location, '')) LIKE ? THEN 170 ELSE 0 END");
    scoreParams.push(safeLike(phrase));
    scoreParts.push("CASE WHEN lower(COALESCE(f.title, '')) LIKE ? THEN 140 ELSE 0 END");
    scoreParams.push(safeLike(phrase));
    scoreParts.push("CASE WHEN lower(e.description) LIKE ? THEN 12000 ELSE 0 END");
    scoreParams.push(safeLike(phrase));
    scoreParts.push("CASE WHEN lower(COALESCE(e.keywords, '')) LIKE ? THEN 10000 ELSE 0 END");
    scoreParams.push(safeLike(phrase));

    // Strong boost when words appear in the same order as the query.
    scoreParts.push("CASE WHEN lower(e.description) LIKE ? THEN 15000 ELSE 0 END");
    scoreParams.push(orderedPattern);
    scoreParts.push("CASE WHEN lower(COALESCE(e.keywords, '')) LIKE ? THEN 14000 ELSE 0 END");
    scoreParams.push(orderedPattern);
    scoreParts.push("CASE WHEN lower(COALESCE(f.title, '')) LIKE ? THEN 8000 ELSE 0 END");
    scoreParams.push(orderedPattern);

    for (const token of tokens) {
      perTokenClauses.push(`(
        lower(e.description) LIKE ?
        OR lower(COALESCE(e.keywords, '')) LIKE ?
        OR lower(COALESCE(e.location, '')) LIKE ?
        OR lower(COALESCE(f.title, '')) LIKE ?
        OR lower(COALESCE(f.cabinet, '')) LIKE ?
      )`);
      const like = safeLike(token);
      params.push(like, like, like, like, like);

      scoreParts.push("CASE WHEN lower(COALESCE(f.cabinet, '')) LIKE ? THEN 45 ELSE 0 END");
      scoreParams.push(like);
      scoreParts.push("CASE WHEN lower(COALESCE(e.location, '')) LIKE ? THEN 35 ELSE 0 END");
      scoreParams.push(like);
      scoreParts.push("CASE WHEN lower(COALESCE(f.title, '')) LIKE ? THEN 30 ELSE 0 END");
      scoreParams.push(like);
      scoreParts.push("CASE WHEN lower(e.description) LIKE ? THEN 20 ELSE 0 END");
      scoreParams.push(like);
      scoreParts.push("CASE WHEN lower(COALESCE(e.keywords, '')) LIKE ? THEN 15 ELSE 0 END");
      scoreParams.push(like);

      // Coverage bonus: each token found in any field adds strong relevance.
      scoreParts.push(`CASE WHEN (
        lower(e.description) LIKE ?
        OR lower(COALESCE(e.keywords, '')) LIKE ?
        OR lower(COALESCE(e.location, '')) LIKE ?
        OR lower(COALESCE(f.title, '')) LIKE ?
        OR lower(COALESCE(f.cabinet, '')) LIKE ?
      ) THEN 250 ELSE 0 END`);
      scoreParams.push(like, like, like, like, like);
    }
    if (perTokenClauses.length) {
      // Strict token matching: all tokens must exist in at least one searchable field.
      where.push(`(${perTokenClauses.join(" AND ")})`);
    }
  }

  if (cabinet && String(cabinet).trim()) {
    where.push("lower(COALESCE(f.cabinet, '')) LIKE ?");
    params.push(safeLike(cabinet));
  }

  if (from && String(from).trim()) {
    where.push("date(COALESCE(e.ref_date, f.file_date)) >= date(?)");
    params.push(String(from).trim());
  }

  if (to && String(to).trim()) {
    where.push("date(COALESCE(e.ref_date, f.file_date)) <= date(?)");
    params.push(String(to).trim());
  }

  if (file_id && String(file_id).trim()) {
    where.push("e.file_id = ?");
    params.push(Number(file_id));
  }

  const rows = db.prepare(`
    SELECT
      e.id,
      e.description,
      e.keywords,
      e.location,
      e.ref_date,
      e.created_at,
      f.id AS file_id,
      f.title AS file_title,
      f.drive_url,
      f.cabinet,
      f.file_date,
      (${scoreParts.join(" + ")}) AS relevance_score
    FROM entries e
    LEFT JOIN files f ON f.id = e.file_id
    WHERE ${where.join(" AND ")}
    ORDER BY relevance_score DESC, COALESCE(e.ref_date, f.file_date, e.created_at) DESC, e.id DESC
    LIMIT 200
  `).all(...scoreParams, ...params);

  res.json(rows);
});

router.get("/entries/:id/open", requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT e.id, f.drive_url
    FROM entries e
    LEFT JOIN files f ON f.id = e.file_id
    WHERE e.id = ?
  `).get(Number(req.params.id));

  if (!row) return res.status(404).json({ message: "Registro no encontrado" });
  if (!row.drive_url) return res.status(404).json({ message: "Registro sin archivo asociado" });

  const mode = String(req.query.mode || "view").toLowerCase();
  const term = String(req.query.q || "").trim();
  if (mode === "edit" && !canEditEmail(req.user?.email)) {
    return res.status(403).json({ message: "Tu correo no tiene permiso de edicion" });
  }

  let url = row.drive_url;
  let highlightApplied = false;
  if (term && /\.pdf($|\?)/i.test(url)) {
    const sep = url.includes("#") ? "&" : "#";
    url = `${url}${sep}search=${encodeURIComponent(term)}`;
    highlightApplied = true;
  }

  res.json({ url, mode, highlight_applied: highlightApplied, term });
});

module.exports = router;


