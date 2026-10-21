import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const API = "http://localhost:3000/api";

const blankMember = {
  name: "", email: "", phone: "", department: "", year: "",
  designation: "", status: "Active", joinedAt: new Date().toISOString().slice(0, 10),
  bio: "", teamIds: []
};

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("membershipToken") || "");
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("membershipUser") || "null"); }
    catch { return null; }
  });
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [members, setMembers] = useState([]);
  const [archivedMembers, setArchivedMembers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, pending: 0 });
  const [recent, setRecent] = useState([]);
  const [departmentCounts, setDepartmentCounts] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [teamFilter, setTeamFilter] = useState("All");
  const [sortBy, setSortBy] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);
  const [activeTab, setActiveTab] = useState("Members");
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState(null);
  const [memberForm, setMemberForm] = useState(blankMember);
  const [selectedMember, setSelectedMember] = useState(null);
  const [teamForm, setTeamForm] = useState({ name: "", description: "" });
  const [editingTeamId, setEditingTeamId] = useState(null);
  const [editingTeamForm, setEditingTeamForm] = useState({ name: "", description: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = user?.role === "admin";

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem("membershipToken");
        localStorage.removeItem("membershipUser");
        setToken("");
        setUser(null);
      }
      throw new Error(data.error || "Request failed.");
    }
    return data;
  }, [token]);

  const loadData = useCallback(async () => {
    if (!token) return;
    try {
      const [memberData, teamData, dashboardData] = await Promise.all([
        request("/members"), request("/teams"), request("/dashboard")
      ]);
      setMembers(memberData.members || []);
      setTeams(teamData.teams || []);
      setStats(dashboardData.stats || { total: 0, active: 0, inactive: 0, pending: 0 });
      setRecent(dashboardData.recent || []);
      setDepartmentCounts(dashboardData.departmentCounts || []);
      if (isAdmin) {
        const archived = await request("/members/archived");
        setArchivedMembers(archived.members || []);
      } else {
        setArchivedMembers([]);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [token, request, isAdmin]);

  useEffect(() => {
    if (!token) return;
    loadData();
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [token, loadData]);

  useEffect(() => { setPage(1); }, [search, statusFilter, teamFilter, sortBy, sortDirection]);

  async function handleAuth(event) {
    event.preventDefault();
    setError(""); setMessage(""); setBusy(true);
    try {
      const endpoint = authMode === "register" ? "/auth/register" : "/auth/login";
      const data = await fetch(`${API}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authForm)
      }).then(async response => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Authentication failed.");
        return result;
      });
      localStorage.setItem("membershipToken", data.token);
      localStorage.setItem("membershipUser", JSON.stringify(data.user));
      setToken(data.token); setUser(data.user);
      setMessage(`Welcome, ${data.user.name}.`);
      setAuthForm({ name: "", email: "", password: "" });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function logout() {
    localStorage.removeItem("membershipToken");
    localStorage.removeItem("membershipUser");
    setToken(""); setUser(null); setMembers([]); setTeams([]);
    setMessage("You have logged out."); setError("");
  }

  async function runAction(action, successText) {
    setError(""); setMessage("");
    try { await action(); setMessage(successText); await loadData(); }
    catch (e) { setError(e.message); }
  }

  function startAddMember() {
    setEditingMemberId(null);
    setMemberForm({ ...blankMember, teamIds: [] });
    setShowMemberForm(true); setSelectedMember(null);
  }

  function startEditMember(member) {
    setEditingMemberId(member.id);
    setMemberForm({
      name: member.name || "", email: member.email || "", phone: member.phone || "",
      department: member.department || "", year: member.year || "",
      designation: member.designation || "", status: member.status || "Active",
      joinedAt: member.joinedAt || "", bio: member.bio || "",
      teamIds: (member.teams || []).map(t => t.id)
    });
    setShowMemberForm(true); setSelectedMember(null);
  }

  async function saveMember(event) {
    event.preventDefault();
    await runAction(async () => {
      const path = editingMemberId ? `/members/${editingMemberId}` : "/members";
      await request(path, { method: editingMemberId ? "PUT" : "POST", body: JSON.stringify(memberForm) });
      setShowMemberForm(false); setEditingMemberId(null); setMemberForm(blankMember);
    }, editingMemberId ? "Member updated." : "Member added.");
  }

  async function archiveMember(member) {
    if (!window.confirm(`Archive ${member.name}? You can restore them later.`)) return;
    await runAction(() => request(`/members/${member.id}/archive`, { method: "PATCH" }), "Member archived.");
    setSelectedMember(null);
  }

  async function restoreMember(member) {
    await runAction(() => request(`/members/${member.id}/restore`, { method: "PATCH" }), "Member restored.");
  }

  async function permanentlyDelete(member) {
    if (!window.confirm(`Permanently delete ${member.name}? This cannot be undone.`)) return;
    await runAction(() => request(`/members/${member.id}`, { method: "DELETE" }), "Member permanently deleted.");
  }

  async function createTeam(event) {
    event.preventDefault();
    await runAction(async () => {
      await request("/teams", { method: "POST", body: JSON.stringify(teamForm) });
      setTeamForm({ name: "", description: "" });
    }, "Team created.");
  }

  function beginTeamEdit(team) {
    setEditingTeamId(team.id);
    setEditingTeamForm({ name: team.name, description: team.description || "" });
  }

  async function saveTeam(event) {
    event.preventDefault();
    await runAction(async () => {
      await request(`/teams/${editingTeamId}`, {
        method: "PUT", body: JSON.stringify({ ...editingTeamForm, leadMemberId: null })
      });
      setEditingTeamId(null);
    }, "Team updated.");
  }

  async function deleteTeam(team) {
    if (!window.confirm(`Delete team "${team.name}"?`)) return;
    await runAction(() => request(`/teams/${team.id}`, { method: "DELETE" }), "Team deleted.");
  }

  const visibleMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = members.filter(member => {
      const matchesSearch = !q || [
        member.name, member.email, member.department, member.year, member.designation,
        ...(member.teams || []).map(t => t.name)
      ].some(value => String(value || "").toLowerCase().includes(q));
      const matchesStatus = statusFilter === "All" || member.status === statusFilter;
      const matchesTeam = teamFilter === "All" || member.teams.some(t => String(t.id) === teamFilter);
      return matchesSearch && matchesStatus && matchesTeam;
    });
    filtered.sort((a, b) => {
      const left = String(a[sortBy] || "").toLowerCase();
      const right = String(b[sortBy] || "").toLowerCase();
      const comparison = left.localeCompare(right, undefined, { numeric: true });
      return sortDirection === "asc" ? comparison : -comparison;
    });
    return filtered;
  }, [members, search, statusFilter, teamFilter, sortBy, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(visibleMembers.length / pageSize));
  const pageMembers = visibleMembers.slice((page - 1) * pageSize, page * pageSize);

  if (!token || !user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand-mark">M</div>
          <p className="eyebrow">ACM · MEMBERSHIP PORTAL</p>
          <h1>{authMode === "login" ? "Welcome back" : "Create an account"}</h1>
          <p className="muted">Manage your club directory, teams, and membership status.</p>
          {error && <div className="alert error">{error}</div>}
          {message && <div className="alert success">{message}</div>}
          <form className="stack-form" onSubmit={handleAuth}>
            {authMode === "register" && <label>Full name<input required maxLength="100" value={authForm.name} onChange={e => setAuthForm({ ...authForm, name: e.target.value })} /></label>}
            <label>Email address<input required type="email" autoComplete="email" value={authForm.email} onChange={e => setAuthForm({ ...authForm, email: e.target.value })} /></label>
            <label>Password<input required type="password" minLength="8" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authForm.password} onChange={e => setAuthForm({ ...authForm, password: e.target.value })} /><small>At least 8 characters.</small></label>
            <button className="primary-button full-width" disabled={busy}>{busy ? "Please wait…" : authMode === "login" ? "Log in" : "Register"}</button>
          </form>
          <p className="auth-switch">
            {authMode === "login" ? "Don't have an account?" : "Already registered?"}
            <button className="text-button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}>
              {authMode === "login" ? "Create one" : "Log in"}
            </button>
          </p>
          <p className="hint">The first account registered on a fresh database becomes the administrator. Later accounts are regular users.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><div className="brand-mark small">M</div><div><strong>MemberSpace</strong><span>Membership Management</span></div></div>
        <div className="user-area"><div className="user-avatar">{user.name?.slice(0, 1).toUpperCase()}</div><div className="user-meta"><strong>{user.name}</strong><span>{user.role}</span></div><button className="secondary-button" onClick={logout}>Log out</button></div>
      </header>

      <main className="main-content">
        <section className="welcome-row">
          <div><p className="eyebrow">ACM NITK · ADMINISTRATION</p><h1>Membership dashboard</h1><p className="muted">A single place to manage members, teams, and membership details.</p></div>
          {isAdmin && <button className="primary-button" onClick={startAddMember}>＋ Add member</button>}
        </section>

        {error && <div className="alert error">{error}<button onClick={() => setError("")}>×</button></div>}
        {message && <div className="alert success">{message}<button onClick={() => setMessage("")}>×</button></div>}

        <section className="stats-grid">
          <StatCard label="Registered members" value={stats.total} detail="Unarchived records" />
          <StatCard label="Active" value={stats.active} detail="Current members" />
          <StatCard label="Pending" value={stats.pending} detail="Awaiting a decision" />
          <StatCard label="Teams / SIGs" value={teams.length} detail="Available groups" />
        </section>

        <nav className="tabs">
          {["Members", "Teams", ...(isAdmin ? ["Archived"] : []), "Dashboard"].map(tab =>
            <button key={tab} className={activeTab === tab ? "tab active" : "tab"} onClick={() => { setActiveTab(tab); setShowMemberForm(false); setSelectedMember(null); }}>{tab}</button>
          )}
        </nav>

        {activeTab === "Members" && (
          <>
            <section className="panel">
              <div className="section-heading"><div><h2>Member directory</h2><p className="muted">{visibleMembers.length} matching member{visibleMembers.length === 1 ? "" : "s"}</p></div></div>
              <div className="filters">
                <label className="search-field"><span>⌕</span><input placeholder="Search name, email, department…" value={search} onChange={e => setSearch(e.target.value)} /></label>
                <select aria-label="Filter by status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option>All</option><option>Active</option><option>Pending</option><option>Inactive</option></select>
                <select aria-label="Filter by team" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}><option value="All">All teams</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                <select aria-label="Sort members" value={sortBy} onChange={e => setSortBy(e.target.value)}><option value="name">Sort: name</option><option value="email">Sort: email</option><option value="department">Sort: department</option><option value="year">Sort: year</option><option value="joinedAt">Sort: date joined</option></select>
                <button className="secondary-button" onClick={() => { setSearch(""); setStatusFilter("All"); setTeamFilter("All"); setSortBy("name"); setSortDirection("asc"); }}>Clear filters</button>
                <button className="icon-button" aria-label="Toggle sort direction" title="Toggle sort direction" onClick={() => setSortDirection(sortDirection === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "↑" : "↓"}</button>
              </div>
            </section>

            {showMemberForm && isAdmin && (
              <section className="panel">
                <div className="section-heading"><h2>{editingMemberId ? "Edit member" : "Add a member"}</h2><button className="text-button" onClick={() => setShowMemberForm(false)}>Cancel</button></div>
                <form className="member-form" onSubmit={saveMember}>
                  <label>Full name *<input required maxLength="100" value={memberForm.name} onChange={e => setMemberForm({ ...memberForm, name: e.target.value })} /></label>
                  <label>Email *<input required type="email" value={memberForm.email} onChange={e => setMemberForm({ ...memberForm, email: e.target.value })} /></label>
                  <label>Phone / contact<input value={memberForm.phone} onChange={e => setMemberForm({ ...memberForm, phone: e.target.value })} /></label>
                  <label>Department<input value={memberForm.department} onChange={e => setMemberForm({ ...memberForm, department: e.target.value })} /></label>
                  <label>Year of study<input placeholder="e.g. 2nd year" value={memberForm.year} onChange={e => setMemberForm({ ...memberForm, year: e.target.value })} /></label>
                  <label>Designation / role<input placeholder="e.g. Core member" value={memberForm.designation} onChange={e => setMemberForm({ ...memberForm, designation: e.target.value })} /></label>
                  <label>Membership status<select value={memberForm.status} onChange={e => setMemberForm({ ...memberForm, status: e.target.value })}><option>Active</option><option>Pending</option><option>Inactive</option></select></label>
                  <label>Date joined<input type="date" value={memberForm.joinedAt} onChange={e => setMemberForm({ ...memberForm, joinedAt: e.target.value })} /></label>
                  <fieldset className="team-checkboxes"><legend>Teams / SIGs (select any number)</legend>{teams.length === 0 ? <p className="muted">Create a team first.</p> : teams.map(team => <label className="checkbox-label" key={team.id}><input type="checkbox" checked={memberForm.teamIds.includes(team.id)} onChange={e => setMemberForm({ ...memberForm, teamIds: e.target.checked ? [...memberForm.teamIds, team.id] : memberForm.teamIds.filter(id => id !== team.id) })} />{team.name}</label>)}</fieldset>
                  <label className="wide-field">Profile / bio<textarea rows="3" maxLength="2000" value={memberForm.bio} onChange={e => setMemberForm({ ...memberForm, bio: e.target.value })} /></label>
                  <div className="form-actions wide-field"><button className="primary-button" disabled={busy}>{editingMemberId ? "Save changes" : "Create member"}</button><button type="button" className="secondary-button" onClick={() => setShowMemberForm(false)}>Cancel</button></div>
                </form>
              </section>
            )}

            {selectedMember && (
              <section className="panel profile-panel">
                <div className="section-heading"><div><p className="eyebrow">MEMBER PROFILE</p><h2>{selectedMember.name}</h2></div><button className="secondary-button" onClick={() => setSelectedMember(null)}>Close profile</button></div>
                <div className="profile-content"><div className="profile-avatar">{selectedMember.name.slice(0, 1).toUpperCase()}</div><div className="profile-details">
                  <p><strong>Email</strong><span>{selectedMember.email}</span></p><p><strong>Contact</strong><span>{selectedMember.phone || "Not provided"}</span></p><p><strong>Department</strong><span>{selectedMember.department || "Not provided"}</span></p><p><strong>Year</strong><span>{selectedMember.year || "Not provided"}</span></p><p><strong>Designation</strong><span>{selectedMember.designation || "Not provided"}</span></p><p><strong>Date joined</strong><span>{selectedMember.joinedAt || "Not provided"}</span></p><p><strong>Teams</strong><span>{selectedMember.teams?.map(t => t.name).join(", ") || "No team assigned"}</span></p><p><strong>Status</strong><span><StatusBadge status={selectedMember.status} /></span></p><p className="bio-row"><strong>About</strong><span>{selectedMember.bio || "No profile information added."}</span></p>
                </div></div>
                {isAdmin && <div className="form-actions"><button className="primary-button" onClick={() => startEditMember(selectedMember)}>Edit member</button><button className="danger-button" onClick={() => archiveMember(selectedMember)}>Archive member</button></div>}
              </section>
            )}

            <section className="member-grid">
              {pageMembers.map(member => <article className="member-card" key={member.id}>
                <div className="member-card-top"><div className="profile-avatar">{member.name.slice(0, 1).toUpperCase()}</div><StatusBadge status={member.status} /></div>
                <button className="member-name" onClick={() => setSelectedMember(member)}>{member.name}</button>
                <p className="member-email">{member.email}</p>
                <p className="member-role">{member.designation || "Member"}{member.department ? ` · ${member.department}` : ""}</p>
                <div className="tag-row">{member.teams?.length ? member.teams.map(team => <span className="tag" key={team.id}>{team.name}</span>) : <span className="muted small-text">No team assigned</span>}</div>
                <div className="card-footer"><button className="text-button" onClick={() => setSelectedMember(member)}>View profile →</button>{isAdmin && <button className="text-button" onClick={() => startEditMember(member)}>Edit</button>}</div>
              </article>)}
            </section>
            {pageMembers.length === 0 && <EmptyState title="No members found" detail="Try changing your search or filters." action={<button className="secondary-button" onClick={() => { setSearch(""); setStatusFilter("All"); setTeamFilter("All"); }}>Clear filters</button>} />}
            {visibleMembers.length > 0 && <div className="pagination"><span>Page {page} of {pageCount}</span><label>Per page <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}><option value="6">6</option><option value="12">12</option><option value="24">24</option></select></label><div><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="secondary-button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button></div></div>}
          </>
        )}

        {activeTab === "Teams" && (
          <section className="panel">
            <div className="section-heading"><div><h2>Teams and special interest groups</h2><p className="muted">Organize members into one or more teams.</p></div></div>
            {isAdmin && <form className="team-create-form" onSubmit={createTeam}><label>Team name<input required maxLength="100" placeholder="e.g. Competitive Programming" value={teamForm.name} onChange={e => setTeamForm({ ...teamForm, name: e.target.value })} /></label><label>Description<input maxLength="500" placeholder="What does this team do?" value={teamForm.description} onChange={e => setTeamForm({ ...teamForm, description: e.target.value })} /></label><button className="primary-button">Create team</button></form>}
            <div className="team-list">{teams.map(team => <article className="team-row" key={team.id}>
              {editingTeamId === team.id ? <form className="team-edit-form" onSubmit={saveTeam}><input required value={editingTeamForm.name} onChange={e => setEditingTeamForm({ ...editingTeamForm, name: e.target.value })} /><input placeholder="Description" value={editingTeamForm.description} onChange={e => setEditingTeamForm({ ...editingTeamForm, description: e.target.value })} /><button className="primary-button">Save</button><button type="button" className="secondary-button" onClick={() => setEditingTeamId(null)}>Cancel</button></form> : <><div className="team-info"><h3>{team.name}</h3><p>{team.description || "No description provided."}</p><span>{team.memberCount} member{team.memberCount === 1 ? "" : "s"}</span><div className="tag-row">{members.filter(m => m.teams.some(t => t.id === team.id)).slice(0, 8).map(m => <button key={m.id} className="tag tag-button" onClick={() => { setActiveTab("Members"); setSearch(m.name); }}>{m.name}</button>)}</div></div>{isAdmin && <div className="team-actions"><button className="secondary-button" onClick={() => beginTeamEdit(team)}>Rename / edit</button><button className="danger-button" onClick={() => deleteTeam(team)}>Delete</button></div>}</>}
            </article>)}</div>
            {teams.length === 0 && <EmptyState title="No teams yet" detail="Create a team to start organizing members." />}
            {!isAdmin && <p className="hint">Only administrators can create, edit, or delete teams.</p>}
          </section>
        )}

        {activeTab === "Archived" && isAdmin && (
          <section className="panel"><div className="section-heading"><div><h2>Archived members</h2><p className="muted">Restore a member to return them to the directory.</p></div></div>
            {archivedMembers.length === 0 ? <EmptyState title="No archived members" detail="Archived records will appear here." /> : <div className="archived-list">{archivedMembers.map(member => <div className="archived-row" key={member.id}><div><strong>{member.name}</strong><p className="muted">{member.email}</p></div><div className="form-actions"><button className="secondary-button" onClick={() => restoreMember(member)}>Restore</button><button className="danger-button" onClick={() => permanentlyDelete(member)}>Delete permanently</button></div></div>)}</div>}
          </section>
        )}

        {activeTab === "Dashboard" && (
          <section className="dashboard-columns">
            <div className="panel"><h2>Membership overview</h2><div className="bar-list">{[["Active", stats.active], ["Pending", stats.pending], ["Inactive", stats.inactive]].map(([label, value]) => <div className="bar-item" key={label}><div><span>{label}</span><strong>{value}</strong></div><div className="bar-track"><div className={`bar-fill ${String(label).toLowerCase()}`} style={{ width: `${stats.total ? (value / stats.total) * 100 : 0}%` }} /></div></div>)}</div></div>
            <div className="panel"><h2>Members by department</h2>{departmentCounts.length ? <div className="department-list">{departmentCounts.map(item => <div key={item.label}><span>{item.label}</span><strong>{item.count}</strong></div>)}</div> : <EmptyState title="No department data" detail="Add department information to member profiles." />}</div>
            <div className="panel full-column"><h2>Recently added members</h2>{recent.length ? <div className="recent-list">{recent.map(member => <div className="recent-row" key={member.id}><div className="profile-avatar mini">{member.name.slice(0, 1).toUpperCase()}</div><div><strong>{member.name}</strong><p>{member.email}</p></div><StatusBadge status={member.status} /></div>)}</div> : <EmptyState title="No members yet" detail="Newly created member records will appear here." />}</div>
          </section>
        )}

        <footer className="footer">Membership Management System <span>·</span> Built for ACM NITK</footer>
      </main>
    </div>
  );
}

function StatCard({ label, value, detail }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
function StatusBadge({ status }) {
  return <span className={`status-badge ${String(status || "").toLowerCase()}`}>{status}</span>;
}
function EmptyState({ title, detail, action }) {
  return <div className="empty-state"><div className="empty-icon">⌕</div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

export default App;