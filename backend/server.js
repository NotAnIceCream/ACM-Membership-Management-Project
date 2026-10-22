require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Set JWT_SECRET in backend/.env to a random string of at least 32 characters.");
  process.exit(1);
}

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://localhost:5173"
}));
app.use(express.json({ limit: "1mb" }));

const db = new Database(path.join(__dirname, "members.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    designation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Active'
      CHECK(status IN ('Active', 'Pending', 'Inactive')),
    joined_at TEXT NOT NULL DEFAULT (date('now')),
    bio TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    lead_member_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_member_id) REFERENCES members(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    member_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    designation TEXT NOT NULL DEFAULT '',
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(member_id, team_id),
    FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
  );
`);

// Migrate databases created by the earlier prototype without deleting existing records.
function ensureColumn(table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

ensureColumn("members", "phone", "TEXT NOT NULL DEFAULT ''");
ensureColumn("members", "department", "TEXT NOT NULL DEFAULT ''");
ensureColumn("members", "year", "TEXT NOT NULL DEFAULT ''");
ensureColumn("members", "designation", "TEXT NOT NULL DEFAULT ''");
ensureColumn("members", "joined_at", "TEXT");
ensureColumn("members", "bio", "TEXT NOT NULL DEFAULT ''");
ensureColumn("members", "archived", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("members", "created_at", "TEXT");
ensureColumn("members", "updated_at", "TEXT");
ensureColumn("teams", "description", "TEXT NOT NULL DEFAULT ''");
ensureColumn("teams", "lead_member_id", "INTEGER REFERENCES members(id) ON DELETE SET NULL");
db.exec(`UPDATE members SET joined_at = COALESCE(joined_at, date('now')), created_at = COALESCE(created_at, CURRENT_TIMESTAMP), updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)`);

// The earlier version stored one team name directly on each member.
// Convert that value into the new many-to-many memberships table.
const legacyMemberColumns = db.prepare("PRAGMA table_info(members)").all();
if (legacyMemberColumns.some(column => column.name === "team")) {
  const legacyAssignments = db.prepare(`
    SELECT id AS memberId, TRIM(team) AS teamName
    FROM members
    WHERE team IS NOT NULL AND TRIM(team) <> ''
  `).all();
  const findTeam = db.prepare("SELECT id FROM teams WHERE name = ? COLLATE NOCASE");
  const addTeam = db.prepare("INSERT INTO teams (name) VALUES (?)");
  const addMembership = db.prepare(
    "INSERT OR IGNORE INTO memberships (member_id, team_id) VALUES (?, ?)"
  );
  const migrateAssignments = db.transaction(() => {
    for (const assignment of legacyAssignments) {
      let team = findTeam.get(assignment.teamName);
      if (!team) {
        const result = addTeam.run(assignment.teamName);
        team = { id: Number(result.lastInsertRowid) };
      }
      addMembership.run(assignment.memberId, team.id);
    }
  });
  migrateAssignments();
}

const teamCount = db.prepare("SELECT COUNT(*) AS count FROM teams").get().count;
if (teamCount === 0) {
  const insertTeam = db.prepare("INSERT INTO teams (name, description) VALUES (?, ?)");
  const seed = db.transaction(() => {
    insertTeam.run("Web Development", "Build and maintain web applications.");
    insertTeam.run("Machine Learning", "Explore machine learning and AI.");
    insertTeam.run("Design", "Create accessible and thoughtful user experiences.");
  });
  seed();
}

// Convert stored member/team relations into a useful response shape.
function getMember(id, includeArchived = false) {
  const member = db.prepare(`
    SELECT id, name, email, phone, department, year, designation, status,
           joined_at AS joinedAt, bio, archived, created_at AS createdAt,
           updated_at AS updatedAt
    FROM members
    WHERE id = ? ${includeArchived ? "" : "AND archived = 0"}
  `).get(id);
  if (!member) return null;
  member.teams = db.prepare(`
    SELECT t.id, t.name, m.designation AS teamDesignation
    FROM memberships m
    JOIN teams t ON t.id = m.team_id
    WHERE m.member_id = ?
    ORDER BY t.name
  `).all(id);
  return member;
}

function listMembers({ archived = false } = {}) {
  const rows = db.prepare(`
    SELECT id FROM members WHERE archived = ? ORDER BY name COLLATE NOCASE
  `).all(archived ? 1 : 0);
  return rows.map(row => getMember(row.id, true));
}

function httpError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return httpError(res, 401, "Please log in to continue.");
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return httpError(res, 401, "Your session is invalid or has expired. Please log in again.");
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return httpError(res, 403, "Administrator permission is required.");
  next();
}

function issueToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
}

function cleanString(value, maxLength = 200) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateMember(body) {
  const data = {
    name: cleanString(body.name, 100),
    email: cleanString(body.email, 254).toLowerCase(),
    phone: cleanString(body.phone, 40),
    department: cleanString(body.department, 100),
    year: cleanString(body.year, 40),
    designation: cleanString(body.designation, 100),
    status: cleanString(body.status, 20),
    joinedAt: cleanString(body.joinedAt, 30),
    bio: cleanString(body.bio, 2000),
    teamIds: Array.isArray(body.teamIds)
      ? [...new Set(body.teamIds.map(Number).filter(Number.isInteger))]
      : []
  };

  if (!data.name) return { error: "Name is required." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return { error: "Enter a valid email address." };
  }
  if (!["Active", "Pending", "Inactive"].includes(data.status)) {
    return { error: "Choose a valid membership status." };
  }
  if (data.joinedAt && !/^\d{4}-\d{2}-\d{2}$/.test(data.joinedAt)) {
    return { error: "Date joined must use YYYY-MM-DD format." };
  }
  if (data.teamIds.some(id => id <= 0)) return { error: "One or more team selections are invalid." };
  const found = data.teamIds.length
    ? db.prepare(`SELECT COUNT(*) AS count FROM teams WHERE id IN (${data.teamIds.map(() => "?").join(",")})`).get(...data.teamIds).count
    : 0;
  if (found !== data.teamIds.length) return { error: "One or more selected teams no longer exist." };
  return { data };
}

// Auth: first registered account becomes admin; later registrations are regular users.
app.post("/api/auth/register", (req, res) => {
  const name = cleanString(req.body.name, 100);
  const email = cleanString(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!name) return httpError(res, 400, "Name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return httpError(res, 400, "Enter a valid email address.");
  if (password.length < 8) return httpError(res, 400, "Password must be at least 8 characters long.");

  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const role = count === 0 ? "admin" : "user";
  try {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)"
    ).run(name, email, hash, role);
    const user = { id: Number(result.lastInsertRowid), name, email, role };
    return res.status(201).json({ token: issueToken(user), user });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT")) return httpError(res, 409, "An account with this email already exists.");
    console.error(error);
    return httpError(res, 500, "Could not create account.");
  }
});

app.post("/api/auth/login", (req, res) => {
  const email = cleanString(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return httpError(res, 401, "Email or password is incorrect.");
  }
  const publicUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  return res.json({ token: issueToken(publicUser), user: publicUser });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(req.user.id);
  if (!user) return httpError(res, 401, "Account no longer exists.");
  res.json({ user });
});

app.get("/", (_req, res) => res.send("Membership Management System API is running."));

// All application data endpoints require a valid login.
app.use("/api/members", requireAuth);
app.use("/api/teams", requireAuth);
app.use("/api/dashboard", requireAuth);

// Member directory and archive.
app.get("/api/members", (req, res) => {
  const search = cleanString(req.query.search, 200).toLowerCase();
  const status = cleanString(req.query.status, 20);
  const teamId = Number(req.query.teamId) || 0;
  let members = listMembers();
  if (search) members = members.filter(m =>
    [m.name, m.email, m.department, m.designation].some(v => String(v).toLowerCase().includes(search))
  );
  if (status && ["Active", "Pending", "Inactive"].includes(status)) {
    members = members.filter(m => m.status === status);
  }
  if (teamId) members = members.filter(m => m.teams.some(t => t.id === teamId));
  res.json({ members });
});

app.get("/api/members/archived", requireAdmin, (_req, res) => {
  res.json({ members: listMembers({ archived: true }) });
});

app.get("/api/members/:id", (req, res) => {
  const member = getMember(Number(req.params.id));
  if (!member) return httpError(res, 404, "Member not found.");
  res.json({ member });
});

app.post("/api/members", requireAdmin, (req, res) => {
  const result = validateMember(req.body);
  if (result.error) return httpError(res, 400, result.error);
  const d = result.data;
  try {
    const transaction = db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO members (name, email, phone, department, year, designation, status, joined_at, bio)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(d.name, d.email, d.phone, d.department, d.year, d.designation, d.status, d.joinedAt || new Date().toISOString().slice(0, 10), d.bio);
      const memberId = Number(insert.lastInsertRowid);
      const assign = db.prepare("INSERT INTO memberships (member_id, team_id, designation) VALUES (?, ?, ?)");
      d.teamIds.forEach(teamId => assign.run(memberId, teamId, d.designation));
      return memberId;
    });
    const id = transaction();
    res.status(201).json({ member: getMember(id) });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return httpError(res, 409, "A member with this email already exists.");
    console.error(error);
    httpError(res, 500, "Could not save member.");
  }
});

app.put("/api/members/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!getMember(id, true)) return httpError(res, 404, "Member not found.");
  const result = validateMember(req.body);
  if (result.error) return httpError(res, 400, result.error);
  const d = result.data;
  try {
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE members
        SET name=?, email=?, phone=?, department=?, year=?, designation=?, status=?, joined_at=?, bio=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(d.name, d.email, d.phone, d.department, d.year, d.designation, d.status,
        d.joinedAt || new Date().toISOString().slice(0, 10), d.bio, id);
      db.prepare("DELETE FROM memberships WHERE member_id = ?").run(id);
      const assign = db.prepare("INSERT INTO memberships (member_id, team_id, designation) VALUES (?, ?, ?)");
      d.teamIds.forEach(teamId => assign.run(id, teamId, d.designation));
    });
    transaction();
    res.json({ member: getMember(id, true) });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return httpError(res, 409, "Another member already uses this email.");
    console.error(error);
    httpError(res, 500, "Could not update member.");
  }
});

app.patch("/api/members/:id/archive", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("UPDATE members SET archived=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived=0").run(id);
  if (!result.changes) return httpError(res, 404, "Member not found or already archived.");
  res.json({ message: "Member archived.", member: getMember(id, true) });
});

app.patch("/api/members/:id/restore", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("UPDATE members SET archived=0, updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived=1").run(id);
  if (!result.changes) return httpError(res, 404, "Archived member not found.");
  res.json({ message: "Member restored.", member: getMember(id) });
});


app.delete("/api/members/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  const member = db.prepare(
    "SELECT id, email FROM members WHERE id = ?"
  ).get(id);

  if (!member) {
    return httpError(res, 404, "Member not found.");
  }

  try {
    const deleteMemberAndAccount = db.transaction(() => {
      db.prepare(
        "DELETE FROM users WHERE email = ? COLLATE NOCASE"
      ).run(member.email);

      db.prepare(
        "DELETE FROM members WHERE id = ?"
      ).run(id);
    });

    deleteMemberAndAccount();

    return res.json({
      message: "Member and associated login account permanently deleted."
    });
  } catch (error) {
    console.error(error);
    return httpError(res, 500, "Could not permanently delete member.");
  }
});


// Team CRUD.
app.get("/api/teams", (_req, res) => {
  const teams = db.prepare(`
    SELECT t.id, t.name, t.description, t.lead_member_id AS leadMemberId,
           lead.name AS leadName,
           COUNT(DISTINCT CASE WHEN m.archived = 0 THEN ms.member_id END) AS memberCount
    FROM teams t
    LEFT JOIN members lead ON lead.id = t.lead_member_id
    LEFT JOIN memberships ms ON ms.team_id = t.id
    LEFT JOIN members m ON m.id = ms.member_id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE
  `).all();
  res.json({ teams });
});

app.post("/api/teams", requireAdmin, (req, res) => {
  const name = cleanString(req.body.name, 100);
  const description = cleanString(req.body.description, 500);
  if (!name) return httpError(res, 400, "Team name is required.");
  try {
    const result = db.prepare("INSERT INTO teams (name, description) VALUES (?, ?)").run(name, description);
    res.status(201).json({ team: db.prepare("SELECT * FROM teams WHERE id=?").get(Number(result.lastInsertRowid)) });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return httpError(res, 409, "A team with that name already exists.");
    console.error(error);
    httpError(res, 500, "Could not create team.");
  }
});

app.put("/api/teams/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const name = cleanString(req.body.name, 100);
  const description = cleanString(req.body.description, 500);
  const leadMemberId = req.body.leadMemberId ? Number(req.body.leadMemberId) : null;
  if (!name) return httpError(res, 400, "Team name is required.");
  if (!db.prepare("SELECT id FROM teams WHERE id=?").get(id)) return httpError(res, 404, "Team not found.");
  if (leadMemberId && !db.prepare("SELECT id FROM members WHERE id=? AND archived=0").get(leadMemberId)) {
    return httpError(res, 400, "Team lead must be an existing, unarchived member.");
  }
  try {
    db.prepare("UPDATE teams SET name=?, description=?, lead_member_id=? WHERE id=?")
      .run(name, description, leadMemberId, id);
    res.json({ team: db.prepare("SELECT * FROM teams WHERE id=?").get(id) });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return httpError(res, 409, "A team with that name already exists.");
    console.error(error);
    httpError(res, 500, "Could not update team.");
  }
});

app.delete("/api/teams/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const team = db.prepare("SELECT id FROM teams WHERE id=?").get(id);
  if (!team) return httpError(res, 404, "Team not found.");
  const assigned = db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE team_id=?").get(id).count;
  if (assigned > 0) return httpError(res, 409, "Reassign or remove this team's members before deleting it.");
  db.prepare("DELETE FROM teams WHERE id=?").run(id);
  res.json({ message: "Team deleted." });
});

// Database-derived dashboard figures.
app.get("/api/dashboard", (_req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status='Inactive' THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN status='Pending' THEN 1 ELSE 0 END) AS pending
    FROM members WHERE archived=0
  `).get();
  const recent = db.prepare(`
    SELECT id, name, email, status, created_at AS createdAt
    FROM members WHERE archived=0 ORDER BY created_at DESC, id DESC LIMIT 5
  `).all();
  const departmentCounts = db.prepare(`
    SELECT COALESCE(NULLIF(department, ''), 'Unspecified') AS label, COUNT(*) AS count
    FROM members WHERE archived=0 GROUP BY label ORDER BY count DESC, label
  `).all();
  res.json({ stats: {
    total: totals.total || 0, active: totals.active || 0,
    inactive: totals.inactive || 0, pending: totals.pending || 0
  }, recent, departmentCounts });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`Membership Management API running at http://localhost:${PORT}`);
});
