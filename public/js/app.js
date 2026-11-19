(function () {
  const STORAGE_KEY = 'fotat_hr_state_v3';
  const SESSION_KEY = 'fotat_hr_session_v3';

  let state = null;
  let currentUser = null;
  let currentLang = 'ar';
  let activeTab = 'dashboard';
  let selectedDeptFilter = 'all';
  let selectedMonth = new Date().toISOString().slice(0, 7);
  let selectedWeekDate = new Date().toISOString().slice(0, 10);
  let showArchived = false;
  let shiftTimerInterval = null;
  let deferredInstallPrompt = null;

  const t = (key) => (window.FOTAT_I18N.dict[currentLang]?.[key] || window.FOTAT_I18N.dict.ar[key] || key);
  const activeEmployees = () => state.employees.filter((e) => !e.archived);
  const canEdit = () => currentUser && currentUser.role === 'super_admin';
  const canEditDeptSchedule = (deptId) =>
    currentUser && (currentUser.role === 'super_admin' || (currentUser.role === 'dept_head' && currentUser.deptId === deptId));

  async function loadState() {
    try {
      const res = await fetch('/api/state?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        state = await res.json();
        return;
      }
    } catch (_) {}
    state = JSON.parse(JSON.stringify(window.FOTAT_SEED));
  }

  async function saveState() {
    try {
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  function applyLanguage(langCode) {
    currentLang = langCode || 'ar';
    const langMeta = window.FOTAT_I18N.langs.find((l) => l.code === currentLang) || window.FOTAT_I18N.langs[0];
    document.documentElement.lang = langMeta.code;
    document.documentElement.dir = langMeta.dir;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    const loginSel = document.getElementById('loginLangSelect');
    const appSel = document.getElementById('appLangSelect');
    if (loginSel) loginSel.value = currentLang;
    if (appSel) appSel.value = currentLang;

    if (currentUser) {
      const u = state.users.find((x) => x.id === currentUser.id);
      if (u) {
        u.lang = currentLang;
        currentUser.lang = currentLang;
        saveState();
      }
      renderApp();
    }
  }

  function populateLangSelectors() {
    const html = window.FOTAT_I18N.langs
      .map((l) => `<option value="${l.code}">${l.flag} ${l.label}</option>`)
      .join('');
    document.getElementById('loginLangSelect').innerHTML = html;
    document.getElementById('appLangSelect').innerHTML = html;
  }

  function getTodayLocalDate() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getActiveLog(empId) {
    if (!state || !Array.isArray(state.attendanceLogs)) return null;
    // An active log is any log that has checkIn and NO checkOut (regardless of date)
    return state.attendanceLogs.find((l) => l.employeeId === empId && l.checkIn && !l.checkOut) || null;
  }

  function getExpiryAlerts() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const alerts = [];
    const docLabels = {
      passport: 'passport',
      residency: 'residency',
      healthCert: 'healthCert',
      workCard: 'workCard'
    };

    activeEmployees().forEach((emp) => {
      Object.keys(docLabels).forEach((docKey) => {
        const doc = emp.docs?.[docKey];
        if (!doc || !doc.expiry) return;
        const expDate = new Date(doc.expiry + 'T00:00:00');
        const diffDays = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays <= 60) {
          alerts.push({
            emp,
            docKey,
            docLabel: t(docLabels[docKey]),
            expiry: doc.expiry,
            diffDays,
            severity: diffDays < 0 ? 'expired' : diffDays <= 30 ? 'soon' : 'warn'
          });
        }
      });
    });

    return alerts.sort((a, b) => a.diffDays - b.diffDays);
  }

  function getAllowedTabs() {
    if (!currentUser) return [];
    switch (currentUser.role) {
      case 'super_admin':
        return ['dashboard', 'departments', 'schedules', 'upload', 'payroll', 'users'];
      case 'owner':
        return ['dashboard', 'departments', 'schedules', 'payroll'];
      case 'dept_head':
        return ['dashboard', 'schedules'];
      case 'employee':
        return ['dashboard', 'schedules'];
      default:
        return ['dashboard'];
    }
  }

  function renderNav() {
    const icons = {
      dashboard: '🏠',
      departments: '🏭',
      schedules: '📅',
      upload: '📸',
      payroll: '💰',
      users: '🔐'
    };
    const tabs = getAllowedTabs();
    if (!tabs.includes(activeTab)) activeTab = tabs[0];

    document.getElementById('navList').innerHTML = tabs
      .map(
        (tab) => `
      <button class="nav-item ${activeTab === tab ? 'active' : ''}" onclick="window._fotatNav('${tab}')">
        <span>${icons[tab]}</span>
        <span>${t('nav_' + tab)}</span>
      </button>`
      )
      .join('');
  }

  function renderAttendanceHero(emp) {
    if (!emp) return '';
    const todayStr = getTodayLocalDate();
    const activeLog = getActiveLog(emp.id);
    const todayLog = activeLog || state.attendanceLogs.find((l) => l.employeeId === emp.id && l.date === todayStr);
    const shift = window.FOTAT_PAYROLL.getShiftForDate(emp, state.schedules, todayStr);

    let statusText = t('notCheckedIn');
    let elapsedHtml = '';
    const isCurrentlyCheckedIn = Boolean(activeLog && activeLog.checkIn && !activeLog.checkOut);

    if (isCurrentlyCheckedIn) {
      const inTime = new Date(activeLog.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusText = `${t('checkedInAt')} ${inTime}`;
      const diffSec = Math.max(0, Math.floor((Date.now() - new Date(activeLog.checkIn).getTime()) / 1000));
      const h = Math.floor(diffSec / 3600);
      const m = Math.floor((diffSec % 3600) / 60);
      const s = diffSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      elapsedHtml = `<div style="margin-top:8px;font-size:1.05rem;color:#fbbf24;font-weight:800;letter-spacing:1px;">⏱️ ${t('elapsedTime')}: <span style="background:rgba(0,0,0,0.3);padding:2px 8px;border-radius:6px;">${pad(h)}:${pad(m)}:${pad(s)}</span></div>`;
    } else if (todayLog?.checkOut) {
      const inTime = new Date(todayLog.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const outTime = new Date(todayLog.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const totalMinutes = Math.max(0, Math.round((new Date(todayLog.checkOut).getTime() - new Date(todayLog.checkIn).getTime()) / 60000));
      const th = (totalMinutes / 60).toFixed(1);
      statusText = `${t('shiftCompleted')} (${inTime} ⬅️ ➡️ ${outTime}) — إجمالي: ${th} ساعة`;
    }

    const shiftLabel = shift.off ? t('shiftOff') : `${shift.start} - ${shift.end} (${shift.hours}h)`;
    return `
      <div class="attendance-hero">
        <div>
          <div style="font-size:0.85rem;color:#94a3b8;">${t('todayShift')}: <strong style="color:#fff;">${shiftLabel}</strong></div>
          <h2 style="margin:6px 0;font-size:1.35rem;">${emp.name} (${emp.code})</h2>
          <div style="font-size:0.95rem;color:#cbd5e1;">${t('shiftStatus')}: <strong>${statusText}</strong></div>
          ${elapsedHtml}
        </div>
        <div class="attendance-actions">
          <button class="btn btn-checkin" ${isCurrentlyCheckedIn ? 'disabled' : ''} onclick="window._fotatCheckIn('${emp.id}')">
            ✅ ${t('checkIn')}
          </button>
          <button class="btn btn-checkout" ${!isCurrentlyCheckedIn ? 'disabled' : ''} onclick="window._fotatCheckOut('${emp.id}')">
            🚪 ${t('checkOut')}
          </button>
        </div>
      </div>`;
  }

  function renderDashboard() {
    if (currentUser.role === 'employee' || currentUser.role === 'dept_head') {
      const emp = state.employees.find((e) => e.id === currentUser.empId) || state.employees[0];
      const summary = emp ? window.FOTAT_PAYROLL.computeMonthlyPayroll(emp, state.attendanceLogs, state.schedules, selectedMonth) : null;
      return `
        ${renderAttendanceHero(emp)}
        ${summary ? `
        <div class="card">
          <div class="section-header">
            <h3 class="section-title">${t('myMonthlySummary')} (${selectedMonth})</h3>
          </div>
          <div class="stats-grid" style="margin-bottom:0;">
            <div class="card"><div class="stat-label">${t('lateHours')}</div><div class="stat-value" style="color:var(--danger);">${summary.lateHours} h</div></div>
            <div class="card"><div class="stat-label">${t('overtimeHours')}</div><div class="stat-value" style="color:var(--success);">${summary.overtimeHours} h</div></div>
            <div class="card"><div class="stat-label">${t('absentDays')}</div><div class="stat-value">${summary.absentDays}</div></div>
            <div class="card"><div class="stat-label">${t('netSalary')}</div><div class="stat-value" style="color:var(--primary);">${summary.netSalary.toLocaleString()} ${t('currency')}</div></div>
          </div>
        </div>` : ''}`;
    }

    const alerts = getExpiryAlerts();
    const todayStr = getTodayLocalDate();
    // Include today's logs + any active overnight shift that has not checked out yet
    const todayLogs = state.attendanceLogs.filter((l) => l.date === todayStr || (!l.checkOut && l.checkIn));
    const activeToday = todayLogs.filter((l) => l.checkIn).length;
    const workingNowLogs = todayLogs.filter((l) => l.checkIn && !l.checkOut);
    const completedLogs = todayLogs.filter((l) => l.checkIn && l.checkOut);

    const workingNowHtml = workingNowLogs.length
      ? workingNowLogs
          .map((l) => {
            const emp = state.employees.find((e) => e.id === l.employeeId);
            if (!emp) return '';
            const dept = state.departments.find((d) => d.id === emp.deptId);
            const inTime = new Date(l.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const diffMin = Math.max(0, Math.floor((Date.now() - new Date(l.checkIn).getTime()) / 60000));
            const h = Math.floor(diffMin / 60);
            const m = diffMin % 60;
            return `
              <tr class="clickable" onclick="window._fotatOpenEmp('${emp.id}')">
                <td><strong>${emp.name}</strong> (${emp.code})</td>
                <td><span class="badge badge-info">${dept?.name || ''}</span></td>
                <td><strong style="color:var(--success);">${inTime}</strong></td>
                <td><strong style="color:var(--primary);letter-spacing:1px;">⏱️ ${h}h ${m}m</strong></td>
                <td><span class="badge badge-success">🟢 متواجد الآن</span></td>
              </tr>`;
          })
          .join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:18px;">${t('noOneCheckedIn')}</td></tr>`;

    const completedHtml = completedLogs.length
      ? completedLogs
          .map((l) => {
            const emp = state.employees.find((e) => e.id === l.employeeId);
            if (!emp) return '';
            const dept = state.departments.find((d) => d.id === emp.deptId);
            const inTime = new Date(l.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const outTime = new Date(l.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const totalMin = Math.max(0, Math.round((new Date(l.checkOut).getTime() - new Date(l.checkIn).getTime()) / 60000));
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            return `
              <tr class="clickable" onclick="window._fotatOpenEmp('${emp.id}')">
                <td><strong>${emp.name}</strong> (${emp.code})</td>
                <td><span class="badge badge-info">${dept?.name || ''}</span></td>
                <td>${inTime}</td>
                <td><strong style="color:var(--danger);">${outTime}</strong></td>
                <td><strong>⏱️ ${h}h ${m}m</strong></td>
              </tr>`;
          })
          .join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:18px;">${t('noOneDeparted')}</td></tr>`;

    const alertsHtml = alerts.length
      ? alerts
          .map((a) => {
            const cls = a.severity === 'expired' ? 'alert-expired' : a.severity === 'soon' ? 'alert-soon' : 'alert-warn';
            const badgeCls = a.severity === 'expired' ? 'badge-danger' : 'badge-warning';
            const daysText = a.diffDays < 0 ? `${t('daysAgo')} ${Math.abs(a.diffDays)} ${t('days')}` : `${a.diffDays} ${t('daysLeft')}`;
            const dept = state.departments.find((d) => d.id === a.emp.deptId);
            return `
              <div class="alert-item ${cls}" onclick="window._fotatOpenEmp('${a.emp.id}')">
                <div>
                  <strong>${a.emp.name}</strong> — ${dept ? dept.name : ''}
                  <div style="font-size:0.84rem;opacity:0.9;">${a.docLabel} (${a.expiry})</div>
                </div>
                <span class="badge ${badgeCls}">${daysText}</span>
              </div>`;
          })
          .join('')
      : `<div style="color:var(--success);font-weight:700;">✅ ${t('noAlerts')}</div>`;

    return `
      <div class="stats-grid">
        <div class="card"><div class="stat-label">${t('totalEmployees')}</div><div class="stat-value">${activeEmployees().length}</div></div>
        <div class="card"><div class="stat-label">${t('activeToday')}</div><div class="stat-value" style="color:var(--success);">${activeToday}</div></div>
        <div class="card"><div class="stat-label">${t('pendingRenewals')}</div><div class="stat-value" style="color:var(--danger);">${alerts.length}</div></div>
        <div class="card"><div class="stat-label">${t('departmentsCount')}</div><div class="stat-value">${state.departments.length}</div></div>
      </div>

      <div class="card" style="margin-bottom:22px;">
        <div class="section-header">
          <h3 class="section-title">🕒 ${t('liveAttendanceMonitor')}</h3>
          <span style="font-size:0.85rem;color:var(--text-muted);font-weight:700;">📅 ${todayStr}</span>
        </div>

        <div style="margin-bottom:18px;">
          <h4 style="font-size:0.95rem;color:var(--success);margin-bottom:8px;">🟢 ${t('currentlyWorking')} (${workingNowLogs.length})</h4>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الموظف</th>
                  <th>القسم</th>
                  <th>${t('checkInTime')}</th>
                  <th>${t('shiftDuration')}</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>${workingNowHtml}</tbody>
            </table>
          </div>
        </div>

        ${completedLogs.length ? `
          <div>
            <h4 style="font-size:0.95rem;color:var(--text-muted);margin-bottom:8px;">🚪 ${t('departedToday')} (${completedLogs.length})</h4>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الموظف</th>
                    <th>القسم</th>
                    <th>${t('checkInTime')}</th>
                    <th>${t('checkOutTime')}</th>
                    <th>إجمالي مدة الشفت</th>
                  </tr>
                </thead>
                <tbody>${completedHtml}</tbody>
              </table>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="card">
        <div class="section-header">
          <h3 class="section-title">🔔 ${t('expiryAlerts')}</h3>
          ${canEdit() ? `<button class="btn btn-primary btn-sm" onclick="window._fotatNav('upload')">📸 ${t('nav_upload')}</button>` : ''}
        </div>
        <div class="alert-list">${alertsHtml}</div>
      </div>`;
  }

  function renderDepartments() {
    const searchVal = (document.getElementById('empSearchInput')?.value || '').toLowerCase();
    const pool = showArchived ? state.employees.filter((e) => e.archived) : activeEmployees();
    const filteredEmps = pool.filter((e) => {
      const matchDept = selectedDeptFilter === 'all' || e.deptId === selectedDeptFilter;
      const matchSearch = !searchVal || e.name.toLowerCase().includes(searchVal) || e.code.toLowerCase().includes(searchVal);
      return matchDept && matchSearch;
    });

    const deptCards = state.departments
      .map((d) => {
        const count = activeEmployees().filter((e) => e.deptId === d.id).length;
        const activeBorder = selectedDeptFilter === d.id ? 'border-color:var(--primary);border-width:2px;' : '';
        return `
          <div class="card dept-card" style="${activeBorder}" onclick="window._fotatFilterDept('${d.id}')">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <h4 style="font-size:1.05rem;">${d.name}</h4>
              <span class="badge badge-info">${count} ${t('employees')}</span>
            </div>
            <div style="font-size:0.84rem;color:var(--text-muted);margin-top:6px;">
              ${t('deptHead')}: <strong>${d.headName || t('notAssigned')}</strong>
            </div>
          </div>`;
      })
      .join('');

    const rows = filteredEmps
      .map((e) => {
        const dept = state.departments.find((d) => d.id === e.deptId);
        return `
          <tr class="clickable" onclick="window._fotatOpenEmp('${e.id}')">
            <td><strong>${e.code}</strong></td>
            <td><strong>${e.name}</strong></td>
            <td>${dept ? dept.name : ''}</td>
            <td>${e.jobTitle}</td>
            <td>${e.docs?.passport?.expiry || '-'}</td>
            <td>${e.docs?.healthCert?.expiry || '-'}</td>
            <td>${e.baseSalary.toLocaleString()} ${t('currency')}</td>
          </tr>`;
      })
      .join('');

    const archivedCount = state.employees.filter((e) => e.archived).length;
    return `
      <div class="section-header">
        <h3 class="section-title">🏭 ${t('nav_departments')} ${showArchived ? `(${t('archivedBadge')})` : ''}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${selectedDeptFilter !== 'all' ? `<button class="btn btn-outline btn-sm" onclick="window._fotatFilterDept('all')">${t('allDepartments')}</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="window._fotatToggleArchiveView()">
            ${showArchived ? `👥 ${t('viewActive')}` : `📦 ${t('viewArchive')} (${archivedCount})`}
          </button>
          ${canEdit() && !showArchived ? `<button class="btn btn-primary btn-sm" onclick="window._fotatOpenAddEmp()">➕ ${t('addEmployee')}</button>` : ''}
        </div>
      </div>

      <div class="dept-grid">${deptCards}</div>

      <div class="card">
        <div class="section-header">
          <input id="empSearchInput" type="text" style="max-width:320px;" placeholder="${t('searchEmployee')}" value="${searchVal}" oninput="window._fotatRerenderDepts()" />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Dept</th><th>Role</th><th>${t('passport')}</th><th>${t('healthCert')}</th><th>${t('salary')}</th>
              </tr>
            </thead>
            <tbody>${rows.length ? rows : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">${t('noEmployeesYet')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderSchedules() {
    const allowedDepts = currentUser.role === 'dept_head'
      ? state.departments.filter((d) => d.id === currentUser.deptId)
      : state.departments;

    const activeDeptId = allowedDepts.some((d) => d.id === selectedDeptFilter)
      ? selectedDeptFilter
      : allowedDepts[0]?.id;

    const deptOptions = allowedDepts
      .map((d) => `<option value="${d.id}" ${d.id === activeDeptId ? 'selected' : ''}>${d.name}</option>`)
      .join('');

    const dayKeys = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
    const baseDate = new Date(selectedWeekDate + 'T12:00:00');
    const dayOfWeek = baseDate.getDay(); // 0=Sun .. 6=Sat
    const diffToSat = (dayOfWeek + 1) % 7;
    const satDate = new Date(baseDate);
    satDate.setDate(baseDate.getDate() - diffToSat);
    const weekDates = dayKeys.map((_, idx) => {
      const d = new Date(satDate);
      d.setDate(satDate.getDate() + idx);
      return d.toISOString().slice(0, 10);
    });

    const emps = activeEmployees().filter((e) => e.deptId === activeDeptId);
    const editable = canEditDeptSchedule(activeDeptId);

    const rows = emps
      .map((emp) => {
        const empSched = state.schedules[activeDeptId]?.[emp.id] || {};
        const cells = dayKeys
          .map((dk) => {
            const s = window.FOTAT_PAYROLL.normalizeShift(empSched[dk]);
            if (!editable) {
              const txt = s.off ? t('shiftOff') : `${s.start} - ${s.end} (${s.hours}h)`;
              return `<td><span class="badge ${s.off ? 'badge-warning' : 'badge-info'}">${txt}</span></td>`;
            }
            return `
              <td style="min-width:145px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:0.75rem;margin-bottom:4px;cursor:pointer;">
                  <input type="checkbox" ${s.off ? 'checked' : ''} style="width:auto;"
                    onchange="window._fotatToggleShiftOff('${activeDeptId}','${emp.id}','${dk}',this.checked)" />
                  <span>${t('shiftOff')}</span>
                </label>
                ${s.off ? '' : `
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    <input type="time" value="${s.start}" style="padding:3px 5px;font-size:0.78rem;"
                      onchange="window._fotatUpdateShiftTime('${activeDeptId}','${emp.id}','${dk}','start',this.value)" />
                    <input type="time" value="${s.end}" style="padding:3px 5px;font-size:0.78rem;"
                      onchange="window._fotatUpdateShiftTime('${activeDeptId}','${emp.id}','${dk}','end',this.value)" />
                    <div style="font-size:0.72rem;color:var(--primary);font-weight:700;">⏱️ ${s.hours}h</div>
                  </div>
                `}
              </td>`;
          })
          .join('');
        return `<tr><td><strong>${emp.name}</strong></td>${cells}</tr>`;
      })
      .join('');

    return `
      <div class="card">
        <div class="section-header">
          <div>
            <h3 class="section-title">📅 ${t('weeklySchedule')}</h3>
            <div style="font-size:0.84rem;color:var(--primary);font-weight:700;margin-top:2px;">
              📆 ${weekDates[0]} ⬅️ ➡️ ${weekDates[6]}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;" class="no-print">
            <button class="btn btn-outline btn-sm" onclick="window._fotatShiftWeek(-7)">◀</button>
            <input type="date" value="${selectedWeekDate}" style="width:auto;padding:6px 10px;font-size:0.85rem;" onchange="window._fotatSetWeekDate(this.value)" />
            <button class="btn btn-outline btn-sm" onclick="window._fotatShiftWeek(7)">▶</button>
            <select style="width:auto;" onchange="window._fotatSelectSchedDept(this.value)">${deptOptions}</select>
            <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ ${t('printReport')}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                ${dayKeys.map((d, i) => `<th><div>${t(d)}</div><div style="font-size:0.75rem;color:var(--primary);font-weight:700;">${weekDates[i]}</div></th>`).join('')}
              </tr>
            </thead>
            <tbody>${rows.length ? rows : `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px;">${t('noEmployeesYet')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderUploadView() {
    if (!canEdit()) return `<div class="card">${t('accessDenied')}</div>`;
    const currentUploadDept = (selectedDeptFilter && selectedDeptFilter !== 'all') ? selectedDeptFilter : (state.departments[0]?.id || 'showroom');
    const deptOpts = state.departments.map((d) => `<option value="${d.id}" ${d.id === currentUploadDept ? 'selected' : ''}>${d.name}</option>`).join('');
    const empOpts = activeEmployees()
      .filter((e) => e.deptId === currentUploadDept)
      .map((e) => `<option value="${e.id}">${e.name} (${e.code})</option>`)
      .join('');

    const docSlots = [
      { key: 'passport', label: t('passport'), icon: '🛂' },
      { key: 'residency', label: t('residency'), icon: '🪪' },
      { key: 'healthCert', label: t('healthCert'), icon: '🏥' },
      { key: 'workCard', label: t('workCard'), icon: '💳' }
    ];

    const slotsHtml = docSlots
      .map(
        (s) => `
      <div class="doc-box">
        <div style="font-weight:800;margin-bottom:8px;">${s.icon} ${s.label}</div>
        <div class="form-group" style="margin-bottom:8px;">
          <input type="file" id="upFile_${s.key}" accept="image/*" onchange="window._fotatHandleDocFile(this, '${s.key}')" style="font-size:0.8rem;padding:6px;" />
        </div>
        <div id="ocrStatus_${s.key}" class="hidden" style="font-size:0.78rem;font-weight:700;margin-bottom:6px;"></div>
        <img id="upPreview_${s.key}" class="hidden" style="width:100%;height:95px;object-fit:cover;border-radius:8px;margin-bottom:8px;" />
        <div class="form-group" style="margin-bottom:8px;">
          <label style="font-size:0.78rem;">${t('docNumber')}</label>
          <input type="text" id="upNum_${s.key}" placeholder="A12345678" style="padding:7px 9px;font-size:0.85rem;" />
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label style="font-size:0.78rem;">${t('expiryDate')}</label>
          <input type="date" id="upExp_${s.key}" style="padding:7px 9px;font-size:0.85rem;" />
        </div>
      </div>`
      )
      .join('');

    return `
      <div class="card" style="max-width:920px;">
        <h3 class="section-title" style="margin-bottom:14px;">📸 ${t('nav_upload')}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">
          <div class="form-group">
            <label>${t('selectDepartment')}</label>
            <select id="upDeptSelect" onchange="window._fotatUpdateUploadEmps(this.value)">${deptOpts}</select>
          </div>
          <div class="form-group">
            <label>${t('selectEmployee')}</label>
            <select id="upEmpSelect" onchange="window._fotatToggleUploadNewEmp(this.value)">
              <option value="__NEW__">➕ إضافة موظف جديد مع المستندات</option>
              ${empOpts}
            </select>
          </div>
        </div>

        <div id="upNewEmpFields" style="background:var(--surface-2);padding:14px;border-radius:12px;margin-bottom:14px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">
            <div class="form-group"><label>اسم الموظف *</label><input id="upNewName" placeholder="يُملأ تلقائياً بالذكاء الاصطناعي أو اكتبه يدوياً" /></div>
            <div class="form-group"><label>المسمى الوظيفي</label><input id="upNewJob" placeholder="شيف / خباز / كاشير / عامل" /></div>
            <div class="form-group"><label>${t('salary')}</label><input id="upNewSalary" type="number" placeholder="الراتب الأساسي (مثال: 5000)" /></div>
            <div class="form-group"><label>${t('bankAccount')}</label><input id="upNewBank" placeholder="EG..." /></div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
            <input type="checkbox" id="upNewIsHead" style="width:auto;" />
            <span>👑 ${t('makeDeptHead')}</span>
          </label>
        </div>

        <div class="doc-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px;">
          ${slotsHtml}
        </div>

        <div id="upErrorMsg" class="hidden" style="color:var(--danger);font-weight:700;margin-bottom:10px;font-size:0.88rem;"></div>
        <button class="btn btn-primary btn-block" onclick="window._fotatSaveUploadedDoc()">💾 ${t('autoSaveDoc')}</button>
      </div>`;
  }

  function renderPayroll() {
    const rows = activeEmployees()
      .map((emp) => {
        const p = window.FOTAT_PAYROLL.computeMonthlyPayroll(emp, state.attendanceLogs, state.schedules, selectedMonth);
        const dept = state.departments.find((d) => d.id === emp.deptId);
        return `
          <tr class="clickable" onclick="window._fotatOpenEmp('${emp.id}')">
            <td><strong>${emp.name}</strong><div style="font-size:0.76rem;color:var(--text-muted);">${dept?.name || ''}</div></td>
            <td>${emp.baseSalary.toLocaleString()}</td>
            <td style="color:var(--danger);font-weight:700;">${p.lateHours} h</td>
            <td style="color:var(--success);font-weight:700;">${p.overtimeHours} h (+${p.overtimePay})</td>
            <td>${p.absentDays}</td>
            <td style="color:var(--danger);">-${p.totalDeductions.toLocaleString()}</td>
            <td><strong style="color:var(--primary);">${p.netSalary.toLocaleString()} ${t('currency')}</strong></td>
            <td style="font-size:0.78rem;">${emp.bankAccount || '-'}</td>
          </tr>`;
      })
      .join('');

    return `
      <div class="card">
        <div class="section-header">
          <h3 class="section-title">💰 ${t('nav_payroll')} (${selectedMonth})</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap;" class="no-print">
            <input type="month" value="${selectedMonth}" style="width:auto;" onchange="window._fotatChangeMonth(this.value)" />
            <button class="btn btn-outline btn-sm" onclick="window._fotatExportPayrollCsv()">📥 ${t('exportCsv')}</button>
            <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ ${t('printReport')}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>${t('salary')}</th><th>${t('lateHours')}</th><th>${t('overtimeHours')}</th>
                <th>${t('absentDays')}</th><th>${t('deductions')}</th><th>${t('netSalary')}</th><th>${t('bankAccount')}</th>
              </tr>
            </thead>
            <tbody>${rows.length ? rows : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">${t('noEmployeesYet')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderUsers() {
    if (!canEdit()) return `<div class="card">${t('accessDenied')}</div>`;
    const rows = state.users
      .map(
        (u) => `
      <tr>
        <td><strong>${u.name}</strong></td>
        <td><code>${u.username}</code></td>
        <td><strong style="color:var(--primary);letter-spacing:1px;">${u.pin}</strong></td>
        <td><span class="badge badge-info">${t('role_' + u.role)}</span></td>
        <td>${u.deptId ? state.departments.find((d) => d.id === u.deptId)?.name || u.deptId : '-'}</td>
      </tr>`
      )
      .join('');
    return `
      <div class="card">
        <div class="section-header">
          <h3 class="section-title">🔐 ${t('nav_users')}</h3>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>${t('username')}</th><th>${t('pin')}</th><th>Role</th><th>Department</th></tr></thead>
            <tbody>${rows.length ? rows : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">${t('noEmployeesYet')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3 class="section-title" style="margin-bottom:8px;">🤖 إعدادات القراءة الذكية للصور (Gemini Vision AI)</h3>
        <p style="font-size:0.86rem;color:var(--text-muted);margin-bottom:12px;">
          أضف مفتاح Gemini API لقراءة صور الباسبور والإقامة والشهادات الصحية بدقة عالية تلقائياً (عربي + إنجليزي).
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <input id="geminiKeyInput" type="password" style="max-width:380px;" placeholder="AIzaSy..." />
          <button class="btn btn-primary btn-sm" onclick="window._fotatSaveGeminiKey()">💾 حفظ المفتاح</button>
        </div>
        <div id="geminiKeyStatus" style="font-size:0.84rem;margin-top:8px;font-weight:700;"></div>
      </div>`;
  }

  function renderApp() {
    document.getElementById('currentUserName').textContent = currentUser.name;
    document.getElementById('currentUserRole').textContent = t('role_' + currentUser.role);
    renderNav();

    const roBanner = currentUser.role === 'owner' ? `<div class="readonly-banner">👁️ ${t('readOnlyNotice')}</div>` : '';
    let bodyHtml = '';
    if (activeTab === 'dashboard') bodyHtml = renderDashboard();
    else if (activeTab === 'departments') bodyHtml = renderDepartments();
    else if (activeTab === 'schedules') bodyHtml = renderSchedules();
    else if (activeTab === 'upload') bodyHtml = renderUploadView();
    else if (activeTab === 'payroll') bodyHtml = renderPayroll();
    else if (activeTab === 'users') bodyHtml = renderUsers();

    document.getElementById('mainContent').innerHTML = roBanner + bodyHtml;
  }

  function openModal(html) {
    document.getElementById('modalBox').innerHTML = html;
    document.getElementById('modalBackdrop').classList.remove('hidden');
  }
  function closeModal() {
    document.getElementById('modalBackdrop').classList.add('hidden');
  }

  // Global handlers
  window._fotatNav = (tab) => {
    activeTab = tab;
    document.getElementById('sidebar').classList.remove('open');
    renderApp();
  };
  window._fotatFilterDept = (deptId) => {
    selectedDeptFilter = deptId;
    renderApp();
  };
  window._fotatRerenderDepts = () => {
    const val = document.getElementById('empSearchInput').value;
    renderApp();
    const inp = document.getElementById('empSearchInput');
    if (inp) {
      inp.value = val;
      inp.focus();
    }
  };
  window._fotatSelectSchedDept = (deptId) => {
    selectedDeptFilter = deptId;
    renderApp();
  };
  window._fotatSetWeekDate = (val) => {
    if (!val) return;
    selectedWeekDate = val;
    renderApp();
  };
  window._fotatShiftWeek = (deltaDays) => {
    const d = new Date(selectedWeekDate + 'T12:00:00');
    d.setDate(d.getDate() + deltaDays);
    selectedWeekDate = d.toISOString().slice(0, 10);
    renderApp();
  };
  window._fotatChangeMonth = (m) => {
    selectedMonth = m;
    renderApp();
  };
  window._fotatToggleShiftOff = (deptId, empId, dayKey, isOff) => {
    if (!canEditDeptSchedule(deptId)) return;
    if (!state.schedules[deptId]) state.schedules[deptId] = {};
    if (!state.schedules[deptId][empId]) state.schedules[deptId][empId] = {};
    const curr = window.FOTAT_PAYROLL.normalizeShift(state.schedules[deptId][empId][dayKey]);
    state.schedules[deptId][empId][dayKey] = isOff
      ? { off: true, start: null, end: null }
      : { off: false, start: curr.start || '06:00', end: curr.end || '16:00' };
    saveState();
    renderApp();
  };

  window._fotatUpdateShiftTime = (deptId, empId, dayKey, field, val) => {
    if (!canEditDeptSchedule(deptId) || !val) return;
    if (!state.schedules[deptId]) state.schedules[deptId] = {};
    if (!state.schedules[deptId][empId]) state.schedules[deptId][empId] = {};
    const curr = window.FOTAT_PAYROLL.normalizeShift(state.schedules[deptId][empId][dayKey]);
    let start = field === 'start' ? val : (curr.start || '06:00');
    let end = field === 'end' ? val : (curr.end || '16:00');
    if (field === 'start') {
      const [h, m] = start.split(':').map(Number);
      const endH = (h + 10) % 24;
      end = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    state.schedules[deptId][empId][dayKey] = { off: false, start, end };
    saveState();
    renderApp();
  };

  window._fotatCheckIn = async (empId) => {
    const todayStr = getTodayLocalDate();
    const existing = state.attendanceLogs.find((l) => l.employeeId === empId && !l.checkOut);
    if (existing) return;

    const newLog = {
      id: 'att_' + Date.now(),
      employeeId: empId,
      date: todayStr,
      checkIn: new Date().toISOString(),
      checkOut: null
    };

    // 1. Update local state
    state.attendanceLogs.push(newLog);
    renderApp();

    // 2. Commit atomic check-in to server
    try {
      const res = await fetch('/api/attendance/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLog)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.attendanceLogs) {
          state.attendanceLogs = data.attendanceLogs;
          renderApp();
        }
      }
    } catch (_) {}
  };

  window._fotatCheckOut = async (empId) => {
    const activeLog = getActiveLog(empId);
    if (!activeLog) return;

    const outIso = new Date().toISOString();
    // 1. Update UI locally immediately
    activeLog.checkOut = outIso;
    renderApp();

    // 2. Commit atomic check-out to server
    try {
      const res = await fetch('/api/attendance/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: empId, checkOut: outIso })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.attendanceLogs) {
          state.attendanceLogs = data.attendanceLogs;
          renderApp();
        }
      }
    } catch (_) {}
  };

  window._fotatOpenEmp = (empId) => {
    if (currentUser.role === 'dept_head' || currentUser.role === 'employee') return;
    const emp = state.employees.find((e) => e.id === empId);
    if (!emp) return;
    const dept = state.departments.find((d) => d.id === emp.deptId);
    const payroll = window.FOTAT_PAYROLL.computeMonthlyPayroll(emp, state.attendanceLogs, state.schedules, selectedMonth);

    const docBox = (key, label) => {
      const d = emp.docs?.[key] || {};
      return `
        <div class="doc-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <strong>${label}</strong>
            ${canEdit() ? `<button class="btn btn-outline btn-sm" style="padding:2px 6px;font-size:0.72rem;" onclick="window._fotatOpenEditDoc('${emp.id}','${key}')">✏️ تعديل</button>` : ''}
          </div>
          <div style="font-size:0.82rem;margin-top:2px;">#: ${d.number || '-'}</div>
          <div style="font-size:0.82rem;">Exp: <strong>${d.expiry || '-'}</strong></div>
          ${d.image ? `<img src="${d.image}" alt="${label}" style="cursor:pointer;" onclick="window.open('${d.image}','_blank')" title="اضغط لتكبير الصورة" />` : ''}
        </div>`;
    };

    const timelineHtml = (emp.timeline || [])
      .slice()
      .reverse()
      .map(
        (item) => `
      <div class="timeline-item">
        <div class="timeline-date">${item.date}</div>
        <div>${item.title}</div>
      </div>`
      )
      .join('');

    openModal(`
      <div class="modal-header">
        <div>
          <h3>${emp.name} (${emp.code})</h3>
          <div style="font-size:0.85rem;color:var(--text-muted);">${dept?.name || ''} — ${emp.jobTitle}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${canEdit() ? `<button class="btn btn-outline btn-sm" onclick="window._fotatOpenEditEmp('${emp.id}')">✏️ ${t('editProfile')}</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="window._fotatCloseModal()">✕</button>
        </div>
      </div>

      <h4 style="margin-bottom:8px;">📄 ${t('documents')}</h4>
      <div class="doc-grid">
        ${docBox('passport', t('passport'))}
        ${docBox('residency', t('residency'))}
        ${docBox('healthCert', t('healthCert'))}
        ${docBox('workCard', t('workCard'))}
      </div>

      <h4 style="margin:14px 0 8px;">💰 ${t('financials')} (${selectedMonth})</h4>
      <div class="stats-grid" style="margin-bottom:12px;">
        <div class="card"><div class="stat-label">${t('salary')}</div><div class="stat-value" style="font-size:1.2rem;">${emp.baseSalary.toLocaleString()} ${t('currency')}</div></div>
        <div class="card"><div class="stat-label">${t('advances')}</div><div class="stat-value" style="font-size:1.2rem;color:var(--warning);">${payroll.advancesTotal.toLocaleString()}</div></div>
        <div class="card"><div class="stat-label">${t('penalties')}</div><div class="stat-value" style="font-size:1.2rem;color:var(--danger);">${payroll.penaltiesTotal.toLocaleString()}</div></div>
        <div class="card"><div class="stat-label">${t('netSalary')}</div><div class="stat-value" style="font-size:1.2rem;color:var(--success);">${payroll.netSalary.toLocaleString()} ${t('currency')}</div></div>
      </div>
      <div style="font-size:0.88rem;margin-bottom:12px;">🏦 <strong>${t('bankAccount')}:</strong> <code>${emp.bankAccount || '-'}</code></div>
      ${canEdit() ? (() => {
        const empUser = state.users.find((u) => u.empId === emp.id);
        return empUser
          ? `<div style="background:var(--primary-light);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:0.88rem;">
               🔐 <strong>بيانات دخول الموظف:</strong>
               ${t('username')}: <code>${empUser.username}</code> |
               ${t('pin')}: <strong style="color:var(--primary);font-size:1rem;">${empUser.pin}</strong> |
               <span class="badge badge-info">${t('role_' + empUser.role)}</span>
             </div>`
          : '';
      })() : ''}

      ${canEdit() ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
          <button class="btn btn-outline btn-sm" onclick="window._fotatAddFinance('${emp.id}','advance')">➕ ${t('addAdvance')}</button>
          <button class="btn btn-outline btn-sm" onclick="window._fotatAddFinance('${emp.id}','penalty')">⚠️ ${t('addPenalty')}</button>
          ${!emp.archived ? `<button class="btn btn-primary btn-sm" onclick="window._fotatAssignDeptHead('${emp.id}')">👑 ${t('makeDeptHead')}</button>` : ''}
          <button class="btn ${emp.archived ? 'btn-success' : 'btn-danger'} btn-sm" onclick="window._fotatToggleArchiveEmp('${emp.id}')">
            ${emp.archived ? `♻️ ${t('restoreEmployee')}` : `📦 ${t('archiveEmployee')}`}
          </button>
        </div>` : ''}

      <h4>🕒 ${t('timeline')}</h4>
      <div class="timeline">${timelineHtml}</div>
    `);
  };

  window._fotatToggleArchiveView = () => {
    showArchived = !showArchived;
    renderApp();
  };

  window._fotatToggleArchiveEmp = (empId) => {
    if (!canEdit()) return;
    const emp = state.employees.find((e) => e.id === empId);
    if (!emp) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    emp.archived = !emp.archived;
    emp.archivedDate = emp.archived ? todayStr : null;

    const empUser = state.users.find((u) => u.empId === emp.id);
    if (empUser) empUser.disabled = emp.archived;

    if (emp.archived) {
      const dept = state.departments.find((d) => d.id === emp.deptId);
      if (dept && dept.headEmpId === emp.id) {
        dept.headName = '';
        dept.headEmpId = null;
      }
      emp.timeline.push({ date: todayStr, title: 'تم أرشفة الموظف وإنهاء الخدمة', type: 'archive' });
    } else {
      emp.timeline.push({ date: todayStr, title: 'تم استعادة الموظف من الأرشيف', type: 'restore' });
    }

    saveState();
    closeModal();
    renderApp();
  };

  window._fotatOpenEditEmp = (empId) => {
    if (!canEdit()) return;
    const emp = state.employees.find((e) => e.id === empId);
    if (!emp) return;
    const deptOpts = state.departments
      .map((d) => `<option value="${d.id}" ${d.id === emp.deptId ? 'selected' : ''}>${d.name}</option>`)
      .join('');
    const empUser = state.users.find((u) => u.empId === emp.id);

    openModal(`
      <div class="modal-header">
        <h3>✏️ ${t('editProfile')} - ${emp.name}</h3>
        <button class="btn btn-outline btn-sm" onclick="window._fotatOpenEmp('${emp.id}')">✕</button>
      </div>
      <form onsubmit="window._fotatSaveEditedEmp(event, '${emp.id}')">
        <div class="form-group"><label>اسم الموظف</label><input id="editEmpName" required value="${emp.name}" /></div>
        <div class="form-group"><label>${t('selectDepartment')}</label><select id="editEmpDept">${deptOpts}</select></div>
        <div class="form-group"><label>المسمى الوظيفي</label><input id="editEmpJob" required value="${emp.jobTitle || ''}" /></div>
        <div class="form-group"><label>رقم الهاتف</label><input id="editEmpPhone" value="${emp.phone || ''}" /></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group"><label>${t('salary')}</label><input id="editEmpSalary" type="number" required value="${emp.baseSalary || 0}" /></div>
          <div class="form-group"><label>${t('bankAccount')}</label><input id="editEmpBank" value="${emp.bankAccount || ''}" /></div>
        </div>
        ${empUser ? `
          <div style="background:var(--surface-2);padding:10px 14px;border-radius:10px;margin-bottom:12px;">
            <div style="font-weight:700;font-size:0.85rem;margin-bottom:8px;">🔐 بيانات تسجيل الدخول:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div class="form-group"><label>${t('username')}</label><input id="editEmpUsername" value="${empUser.username}" required /></div>
              <div class="form-group"><label>${t('pin')}</label><input id="editEmpPin" value="${empUser.pin}" required /></div>
            </div>
          </div>
        ` : ''}
        <button type="submit" class="btn btn-primary btn-block">${t('save')}</button>
      </form>
    `);
  };

  window._fotatSaveEditedEmp = (e, empId) => {
    e.preventDefault();
    if (!canEdit()) return;
    const emp = state.employees.find((x) => x.id === empId);
    if (!emp) return;

    const oldSalary = emp.baseSalary;
    const newSalary = Number(document.getElementById('editEmpSalary').value);
    const newName = document.getElementById('editEmpName').value.trim();
    const newDeptId = document.getElementById('editEmpDept').value;
    const newJob = document.getElementById('editEmpJob').value.trim();
    const newPhone = document.getElementById('editEmpPhone').value.trim();
    const newBank = document.getElementById('editEmpBank').value.trim();

    emp.name = newName;
    emp.deptId = newDeptId;
    emp.jobTitle = newJob;
    emp.phone = newPhone;
    emp.baseSalary = newSalary;
    emp.bankAccount = newBank;

    const todayStr = new Date().toISOString().slice(0, 10);
    if (oldSalary !== newSalary) {
      emp.timeline.push({ date: todayStr, title: `تعديل الراتب من ${oldSalary} إلى ${newSalary} ج.م`, type: 'salary' });
    } else {
      emp.timeline.push({ date: todayStr, title: 'تحديث بيانات الملف الشخصي', type: 'edit' });
    }

    const empUser = state.users.find((u) => u.empId === emp.id);
    if (empUser) {
      empUser.name = newName;
      empUser.deptId = newDeptId;
      const uInp = document.getElementById('editEmpUsername');
      const pInp = document.getElementById('editEmpPin');
      if (uInp) empUser.username = uInp.value.trim();
      if (pInp) empUser.pin = pInp.value.trim();
    }

    saveState();
    window._fotatOpenEmp(empId);
    renderApp();
  };

  let pendingDocEditImage = null;
  window._fotatOpenEditDoc = (empId, docKey) => {
    if (!canEdit()) return;
    const emp = state.employees.find((x) => x.id === empId);
    if (!emp) return;
    const doc = emp.docs?.[docKey] || {};
    pendingDocEditImage = null;

    openModal(`
      <div class="modal-header">
        <h3>📄 ${t('updateDoc')}: ${t(docKey)} - ${emp.name}</h3>
        <button class="btn btn-outline btn-sm" onclick="window._fotatOpenEmp('${emp.id}')">✕</button>
      </div>
      <div class="form-group">
        <label>رفع صورة جديدة (أو مسحها ضوئياً بالذكاء الاصطناعي)</label>
        <input type="file" accept="image/*" onchange="window._fotatHandleDocEditFile(this, '${docKey}')" />
      </div>
      <div id="docEditStatus" class="hidden" style="font-size:0.84rem;font-weight:700;margin-bottom:8px;"></div>
      <div id="docEditPreviewWrap" style="margin-bottom:12px;">
        ${doc.image ? `<img id="docEditPreview" src="${doc.image}" style="max-height:160px;border-radius:10px;object-fit:cover;" />` : `<img id="docEditPreview" class="hidden" style="max-height:160px;border-radius:10px;object-fit:cover;" />`}
      </div>
      <div class="form-group">
        <label>${t('docNumber')}</label>
        <input id="docEditNumber" value="${doc.number || ''}" placeholder="رقم المستند" />
      </div>
      <div class="form-group">
        <label>${t('expiryDate')}</label>
        <input type="date" id="docEditExpiry" value="${doc.expiry || ''}" />
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-primary btn-block" onclick="window._fotatSaveEditedDoc('${emp.id}','${docKey}')">💾 ${t('save')}</button>
        <button class="btn btn-outline" onclick="window._fotatOpenEmp('${emp.id}')">${t('cancel')}</button>
      </div>
    `);
  };

  window._fotatHandleDocEditFile = async (input, docKey) => {
    const file = input.files?.[0];
    if (!file) return;
    const st = document.getElementById('docEditStatus');
    const prev = document.getElementById('docEditPreview');
    st.style.color = 'var(--primary)';
    st.textContent = t('ocrScanning');
    st.classList.remove('hidden');

    const res = await window.FOTAT_OCR.scanDocument(file, docKey);
    pendingDocEditImage = res.imageDataUrl;
    prev.src = res.imageDataUrl;
    prev.classList.remove('hidden');

    if (res.docNumber) document.getElementById('docEditNumber').value = res.docNumber;
    if (res.expiryDate) document.getElementById('docEditExpiry').value = res.expiryDate;

    if (res.source === 'gemini') {
      st.style.color = 'var(--success)';
      st.textContent = '✅ تم استخراج البيانات بالذكاء الاصطناعي';
    } else {
      st.style.color = 'var(--success)';
      st.textContent = '✅ تم تجهيز الصورة';
    }
  };

  window._fotatSaveEditedDoc = (empId, docKey) => {
    if (!canEdit()) return;
    const emp = state.employees.find((x) => x.id === empId);
    if (!emp) return;
    if (!emp.docs) emp.docs = {};

    const num = document.getElementById('docEditNumber').value.trim();
    const exp = document.getElementById('docEditExpiry').value;
    const prevImg = emp.docs[docKey]?.image || '';
    const img = pendingDocEditImage !== null ? pendingDocEditImage : prevImg;

    emp.docs[docKey] = { number: num, expiry: exp, image: img };
    const todayStr = new Date().toISOString().slice(0, 10);
    emp.timeline.push({ date: todayStr, title: `تحديث ${t(docKey)} (${num || '-'}) - ينتهي في ${exp || '-'}`, type: 'doc' });

    pendingDocEditImage = null;
    saveState();
    window._fotatOpenEmp(empId);
    renderApp();
  };

  window._fotatCloseModal = closeModal;

  window._fotatAddFinance = (empId, kind) => {
    if (!canEdit()) return;
    const emp = state.employees.find((e) => e.id === empId);
    const amountStr = prompt(kind === 'advance' ? t('addAdvance') : t('addPenalty'), '500');
    const amount = Number(amountStr);
    if (!amount || amount <= 0) return;
    const note = prompt('Note / السبب', '') || '';
    const todayStr = new Date().toISOString().slice(0, 10);
    if (kind === 'advance') {
      emp.advances.push({ id: 'adv_' + Date.now(), date: todayStr, amount, note });
      emp.timeline.push({ date: todayStr, title: `سلفة ${amount} ج.م ${note ? '- ' + note : ''}`, type: 'advance' });
    } else {
      emp.penalties.push({ id: 'pen_' + Date.now(), date: todayStr, amount, note });
      emp.timeline.push({ date: todayStr, title: `جزاء ${amount} ج.م ${note ? '- ' + note : ''}`, type: 'penalty' });
    }
    saveState();
    window._fotatOpenEmp(empId);
  };

  window._fotatAssignDeptHead = (empId) => {
    if (!canEdit()) return;
    const emp = state.employees.find((e) => e.id === empId);
    const dept = state.departments.find((d) => d.id === emp?.deptId);
    if (!emp || !dept) return;

    // Demote previous head of this department back to employee role
    if (dept.headEmpId && dept.headEmpId !== emp.id) {
      const prevUser = state.users.find((u) => u.empId === dept.headEmpId);
      if (prevUser && prevUser.role === 'dept_head') prevUser.role = 'employee';
    }

    dept.headName = emp.name;
    dept.headEmpId = emp.id;

    let empUser = state.users.find((u) => u.empId === emp.id);
    if (empUser) {
      empUser.role = 'dept_head';
      empUser.deptId = dept.id;
    } else {
      state.users.push({
        id: 'u_' + Date.now(),
        username: emp.code.toLowerCase().replace(/[^a-z0-9]/g, ''),
        pin: '1234',
        name: emp.name,
        role: 'dept_head',
        deptId: dept.id,
        empId: emp.id,
        lang: 'ar'
      });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    emp.timeline.push({ date: todayStr, title: `تعيين كرئيس قسم: ${dept.name}`, type: 'role' });
    saveState();
    window._fotatOpenEmp(empId);
    renderApp();
  };

  function generatePin() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  function showCredentialsModal(emp, user) {
    const dept = state.departments.find((d) => d.id === emp.deptId);
    const copyText = `مصنع فتات للمخبوزات - بيانات الدخول\nالاسم: ${emp.name}\nالقسم: ${dept?.name || ''}\nاسم المستخدم: ${user.username}\nالرقم السري (PIN): ${user.pin}\nالصلاحية: ${t('role_' + user.role)}`;
    openModal(`
      <div class="modal-header">
        <h3>✅ تم إضافة الموظف بنجاح</h3>
        <button class="btn btn-outline btn-sm" onclick="window._fotatCloseModal()">✕</button>
      </div>
      <div style="background:var(--primary-light);border:1px solid #fde68a;border-radius:14px;padding:18px;margin-bottom:16px;">
        <div style="font-size:1.05rem;font-weight:800;margin-bottom:10px;">🔐 بيانات دخول الموظف للسيستم</div>
        <div style="margin-bottom:6px;">👤 <strong>الاسم:</strong> ${emp.name} (${emp.code})</div>
        <div style="margin-bottom:6px;">🏭 <strong>القسم:</strong> ${dept?.name || ''}</div>
        <div style="margin-bottom:6px;">🪪 <strong>${t('username')}:</strong> <code style="font-size:1.05rem;background:#fff;padding:2px 8px;border-radius:6px;">${user.username}</code></div>
        <div style="margin-bottom:6px;">🔑 <strong>${t('pin')}:</strong> <strong style="font-size:1.25rem;color:var(--primary);background:#fff;padding:2px 10px;border-radius:6px;letter-spacing:2px;">${user.pin}</strong></div>
        <div>🛡️ <strong>الصلاحية:</strong> <span class="badge badge-info">${t('role_' + user.role)}</span></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="navigator.clipboard?.writeText(${JSON.stringify(copyText)});this.textContent='✅ تم النسخ!'">📋 نسخ البيانات</button>
        <button class="btn btn-outline" onclick="window._fotatCloseModal()">${t('close')}</button>
      </div>
    `);
  }

  window._fotatOpenAddEmp = () => {
    if (!canEdit()) return;
    const deptOpts = state.departments.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
    const nextCode = 'ft' + (101 + state.employees.length);
    const defaultPin = generatePin();
    openModal(`
      <div class="modal-header">
        <h3>➕ ${t('addEmployee')}</h3>
        <button class="btn btn-outline btn-sm" onclick="window._fotatCloseModal()">✕</button>
      </div>
      <form onsubmit="window._fotatSaveNewEmp(event)">
        <div class="form-group"><label>اسم الموظف *</label><input id="newEmpName" required placeholder="الاسم ثلاثي أو رباعي" /></div>
        <div class="form-group"><label>${t('selectDepartment')}</label><select id="newEmpDept">${deptOpts}</select></div>
        <div class="form-group"><label>المسمى الوظيفي *</label><input id="newEmpJob" required placeholder="شيف / خباز / كاشير / عامل" /></div>
        <div class="form-group"><label>${t('salary')}</label><input id="newEmpSalary" type="number" required placeholder="الراتب الأساسي (مثال: 5000)" /></div>
        <div class="form-group"><label>${t('bankAccount')}</label><input id="newEmpBank" placeholder="EG..." /></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group"><label>${t('username')}</label><input id="newEmpUsername" required value="${nextCode}" /></div>
          <div class="form-group"><label>${t('pin')}</label><input id="newEmpPin" required value="${defaultPin}" /></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-weight:700;cursor:pointer;">
          <input type="checkbox" id="newEmpIsHead" style="width:auto;" />
          <span>👑 ${t('makeDeptHead')}</span>
        </label>
        <button type="submit" class="btn btn-primary btn-block">${t('save')}</button>
      </form>
    `);
  };

  window._fotatSaveNewEmp = async (e) => {
    e.preventDefault();
    if (!canEdit()) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    const id = 'e_' + Date.now();
    const name = document.getElementById('newEmpName').value.trim();
    const deptId = document.getElementById('newEmpDept').value;
    const isHead = document.getElementById('newEmpIsHead').checked;
    const username = document.getElementById('newEmpUsername').value.trim();
    const pin = document.getElementById('newEmpPin').value.trim();
    const salaryRaw = document.getElementById('newEmpSalary').value.trim();
    const baseSalary = salaryRaw ? Number(salaryRaw) : 0;

    const newEmp = {
      id,
      code: 'FT-' + (101 + state.employees.length),
      name,
      deptId,
      jobTitle: document.getElementById('newEmpJob').value.trim(),
      phone: '',
      hireDate: todayStr,
      baseSalary: isNaN(baseSalary) ? 0 : baseSalary,
      bankAccount: document.getElementById('newEmpBank').value.trim(),
      docs: { passport: {}, residency: {}, healthCert: {}, workCard: {} },
      advances: [],
      penalties: [],
      timeline: [{ date: todayStr, title: 'تعيين موظف جديد', type: 'hire' }]
    };
    state.employees.push(newEmp);

    const newUser = {
      id: 'u_' + Date.now(),
      username,
      pin,
      name,
      role: isHead ? 'dept_head' : 'employee',
      deptId,
      empId: id,
      lang: 'ar'
    };
    state.users.push(newUser);

    if (isHead) {
      const dept = state.departments.find((d) => d.id === deptId);
      if (dept) {
        if (dept.headEmpId) {
          const prevUser = state.users.find((u) => u.empId === dept.headEmpId);
          if (prevUser && prevUser.role === 'dept_head') prevUser.role = 'employee';
        }
        dept.headName = newEmp.name;
        dept.headEmpId = newEmp.id;
      }
    }

    await saveState();
    renderApp();
    showCredentialsModal(newEmp, newUser);
  };

  let pendingUploadedImages = { passport: '', residency: '', healthCert: '', workCard: '' };
  window._fotatUpdateUploadEmps = (deptId) => {
    selectedDeptFilter = deptId;
    const sel = document.getElementById('upEmpSelect');
    if (!sel) return;
    const empOpts = activeEmployees()
      .filter((e) => e.deptId === deptId)
      .map((e) => `<option value="${e.id}">${e.name} (${e.code})</option>`)
      .join('');
    sel.innerHTML = `<option value="__NEW__">➕ إضافة موظف جديد مع المستندات</option>` + empOpts;
    window._fotatToggleUploadNewEmp(sel.value);
  };

  window._fotatToggleUploadNewEmp = (val) => {
    const box = document.getElementById('upNewEmpFields');
    if (box) box.classList.toggle('hidden', val !== '__NEW__');
    const docKeys = ['passport', 'residency', 'healthCert', 'workCard'];
    if (val === '__NEW__') {
      docKeys.forEach((key) => {
        const numInput = document.getElementById('upNum_' + key);
        const expInput = document.getElementById('upExp_' + key);
        const preview = document.getElementById('upPreview_' + key);
        const st = document.getElementById('ocrStatus_' + key);
        if (numInput) numInput.value = '';
        if (expInput) expInput.value = '';
        if (preview) { preview.src = ''; preview.classList.add('hidden'); }
        if (st) { st.textContent = ''; st.classList.add('hidden'); }
        pendingUploadedImages[key] = '';
      });
    } else {
      const emp = state.employees.find((e) => e.id === val);
      if (emp && emp.docs) {
        docKeys.forEach((key) => {
          const doc = emp.docs[key] || {};
          const numInput = document.getElementById('upNum_' + key);
          const expInput = document.getElementById('upExp_' + key);
          const preview = document.getElementById('upPreview_' + key);
          const st = document.getElementById('ocrStatus_' + key);
          if (numInput) numInput.value = doc.number || '';
          if (expInput) expInput.value = doc.expiry || '';
          if (preview) {
            if (doc.image) {
              preview.src = doc.image;
              preview.classList.remove('hidden');
            } else {
              preview.src = '';
              preview.classList.add('hidden');
            }
          }
          if (st) {
            if (doc.number || doc.expiry || doc.image) {
              st.style.color = 'var(--text-muted)';
              st.textContent = `مسجل مسبقاً (${doc.number || 'بدون رقم'})`;
              st.classList.remove('hidden');
            } else {
              st.textContent = '';
              st.classList.add('hidden');
            }
          }
          pendingUploadedImages[key] = doc.image || '';
        });
      }
    }
  };

  window._fotatHandleDocFile = async (input, docKey) => {
    const file = input.files?.[0];
    if (!file) return;
    const statusEl = document.getElementById('ocrStatus_' + docKey);
    const previewEl = document.getElementById('upPreview_' + docKey);
    statusEl.style.color = 'var(--primary)';
    statusEl.textContent = t('ocrScanning');
    statusEl.classList.remove('hidden');

    const res = await window.FOTAT_OCR.scanDocument(file, docKey);
    pendingUploadedImages[docKey] = res.imageDataUrl;
    previewEl.src = res.imageDataUrl;
    previewEl.classList.remove('hidden');

    const nameInput = document.getElementById('upNewName');
    if (res.employeeName && nameInput && !nameInput.value.trim()) {
      nameInput.value = res.employeeName;
    }
    const jobInput = document.getElementById('upNewJob');
    if (res.jobTitle && jobInput && !jobInput.value.trim()) {
      jobInput.value = res.jobTitle;
    }
    if (res.docNumber) document.getElementById('upNum_' + docKey).value = res.docNumber;
    if (res.expiryDate) document.getElementById('upExp_' + docKey).value = res.expiryDate;

    const foundAny = Boolean(res.employeeName || res.docNumber || res.expiryDate);
    if (foundAny) {
      statusEl.style.color = 'var(--success)';
      statusEl.textContent = res.source === 'gemini' ? '✅ تم الاستخراج بالذكاء الاصطناعي' : '✅ تم الاستخراج';
    } else if (res.apiError) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = `⚠️ تعذر الاتصال بالذكاء الاصطناعي (${res.apiError}) — أدخل الرقم والتاريخ يدوياً`;
    } else {
      statusEl.style.color = 'var(--warning)';
      statusEl.textContent = '⚠️ أدخل الرقم والتاريخ يدوياً';
    }
  };

  window._fotatSaveUploadedDoc = async () => {
    if (!canEdit()) return;
    const errEl = document.getElementById('upErrorMsg');
    const empSelVal = document.getElementById('upEmpSelect').value;
    const deptId = document.getElementById('upDeptSelect').value;
    const todayStr = getTodayLocalDate();

    let emp = null;
    let createdUser = null;

    if (empSelVal === '__NEW__') {
      const name = document.getElementById('upNewName').value.trim();
      if (!name) {
        errEl.textContent = 'يرجى كتابة اسم الموظف أولاً';
        errEl.classList.remove('hidden');
        return;
      }
      const salaryInput = document.getElementById('upNewSalary');
      const salaryRaw = salaryInput ? salaryInput.value.trim() : '';
      const baseSalary = salaryRaw ? Number(salaryRaw) : 0;

      const empId = 'e_' + Date.now();
      const codeNum = 101 + state.employees.length;
      const isHead = document.getElementById('upNewIsHead').checked;
      emp = {
        id: empId,
        code: 'FT-' + codeNum,
        name,
        deptId,
        jobTitle: document.getElementById('upNewJob').value.trim() || 'موظف',
        phone: '',
        hireDate: todayStr,
        baseSalary: isNaN(baseSalary) ? 0 : baseSalary,
        bankAccount: document.getElementById('upNewBank').value.trim(),
        docs: { passport: {}, residency: {}, healthCert: {}, workCard: {} },
        advances: [],
        penalties: [],
        timeline: [{ date: todayStr, title: 'تعيين موظف جديد', type: 'hire' }]
      };
      state.employees.push(emp);

      createdUser = {
        id: 'u_' + Date.now(),
        username: 'ft' + codeNum,
        pin: generatePin(),
        name,
        role: isHead ? 'dept_head' : 'employee',
        deptId,
        empId,
        lang: 'ar'
      };
      state.users.push(createdUser);

      if (isHead) {
        const dept = state.departments.find((d) => d.id === deptId);
        if (dept) {
          if (dept.headEmpId) {
            const prevUser = state.users.find((u) => u.empId === dept.headEmpId);
            if (prevUser && prevUser.role === 'dept_head') prevUser.role = 'employee';
          }
          dept.headName = emp.name;
          dept.headEmpId = emp.id;
        }
      }
    } else {
      emp = state.employees.find((e) => e.id === empSelVal);
      if (!emp) {
        errEl.textContent = 'يرجى اختيار الموظف أو اختيار إضافة موظف جديد';
        errEl.classList.remove('hidden');
        return;
      }
    }

    errEl.classList.add('hidden');
    if (!emp.docs) emp.docs = {};

    let hasAnyDocUpdate = false;
    ['passport', 'residency', 'healthCert', 'workCard'].forEach((docKey) => {
      const number = document.getElementById('upNum_' + docKey)?.value.trim() || '';
      const expiry = document.getElementById('upExp_' + docKey)?.value || '';
      const image = pendingUploadedImages[docKey] || '';
      if (number || expiry || image) {
        hasAnyDocUpdate = true;
        emp.docs[docKey] = {
          number: number || emp.docs[docKey]?.number || '',
          expiry: expiry || emp.docs[docKey]?.expiry || '',
          image: image || emp.docs[docKey]?.image || ''
        };
        emp.timeline.push({
          date: todayStr,
          title: `تحديث ${t(docKey)} (${number || '-'}) ${expiry ? '- ينتهي في ' + expiry : ''}`,
          type: 'doc'
        });
      }
    });

    if (empSelVal !== '__NEW__' && !hasAnyDocUpdate) {
      errEl.textContent = 'يرجى رفع صورة مستند أو إدخال رقم/تاريخ انتهاء قبل الحفظ';
      errEl.classList.remove('hidden');
      return;
    }

    pendingUploadedImages = { passport: '', residency: '', healthCert: '', workCard: '' };
    await saveState();
    selectedDeptFilter = deptId;
    activeTab = 'departments';
    renderApp();
    if (createdUser) {
      showCredentialsModal(emp, createdUser);
    } else {
      window._fotatOpenEmp(emp.id);
    }
  };

  window._fotatSaveGeminiKey = async () => {
    const key = document.getElementById('geminiKeyInput').value.trim();
    const st = document.getElementById('geminiKeyStatus');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: key })
      });
      if (res.ok) {
        st.style.color = 'var(--success)';
        st.textContent = '✅ تم حفظ مفتاح Gemini API بنجاح! القراءة الذكية بالذكاء الاصطناعي مفعلة الآن.';
      } else {
        throw new Error();
      }
    } catch (_) {
      st.style.color = 'var(--danger)';
      st.textContent = '⚠️ تأكد من تشغيل البرنامج عبر السيرفر (http://localhost:3000) لحفظ المفتاح.';
    }
  };

  window._fotatExportPayrollCsv = () => {
    const lines = [['Code', 'Name', 'Department', 'BaseSalary', 'LateHours', 'OvertimeHours', 'AbsentDays', 'Deductions', 'NetSalary', 'IBAN'].join(',')];
    activeEmployees().forEach((emp) => {
      const p = window.FOTAT_PAYROLL.computeMonthlyPayroll(emp, state.attendanceLogs, state.schedules, selectedMonth);
      const dept = state.departments.find((d) => d.id === emp.deptId);
      lines.push([emp.code, `"${emp.name}"`, `"${dept?.name || ''}"`, emp.baseSalary, p.lateHours, p.overtimeHours, p.absentDays, p.totalDeductions, p.netSalary, emp.bankAccount || ''].join(','));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fotat-payroll-${selectedMonth}.csv`;
    a.click();
  };

  let isSyncingState = false;
  async function syncStateFromServer() {
    if (isSyncingState) return;
    try {
      isSyncingState = true;
      const res = await fetch('/api/state?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const remoteState = await res.json();
        if (remoteState && Array.isArray(remoteState.attendanceLogs)) {
          // If modal is open or user is currently typing or not on dashboard, DO NOT re-render the app!
          const isModalOpen = !document.getElementById('modalBackdrop')?.classList.contains('hidden');
          const isUserTyping = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

          if (activeTab !== 'dashboard' || isModalOpen || isUserTyping) {
            // Keep background logs synced without wiping DOM or destroying form inputs
            state.attendanceLogs = remoteState.attendanceLogs;
            return;
          }

          state = remoteState;
          renderApp();
        }
      }
    } catch (_) {
    } finally {
      isSyncingState = false;
    }
  }

  function loginSuccess(user) {
    currentUser = user;
    localStorage.setItem(SESSION_KEY, user.id);
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    activeTab = 'dashboard';
    applyLanguage(user.lang || currentLang);
    if (shiftTimerInterval) clearInterval(shiftTimerInterval);
    let pollCounter = 0;
    shiftTimerInterval = setInterval(() => {
      pollCounter++;
      // Poll fresh attendance state from server every 10 seconds for real-time sync across devices
      if (pollCounter % 10 === 0) {
        syncStateFromServer();
      }

      if (activeTab === 'dashboard') {
        const isModalOpen = !document.getElementById('modalBackdrop')?.classList.contains('hidden');
        const isUserTyping = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
        if (!isModalOpen && !isUserTyping) {
          if (currentUser?.role === 'employee' || currentUser?.role === 'dept_head') {
            const emp = state.employees.find((e) => e.id === currentUser.empId);
            const todayStr = getTodayLocalDate();
            const todayLog = emp ? state.attendanceLogs.find((l) => l.employeeId === emp.id && (l.date === todayStr || (!l.checkOut && l.checkIn))) : null;
            if (todayLog?.checkIn && !todayLog.checkOut) {
              renderApp();
            }
          } else if (currentUser?.role === 'super_admin' || currentUser?.role === 'owner') {
            // Live refresh for admin and owner to watch active workers
            renderApp();
          }
        }
      }
    }, 1000);
  }

  async function init() {
    populateLangSelectors();
    await loadState();

    document.getElementById('loginLangSelect').addEventListener('change', (e) => applyLanguage(e.target.value));
    document.getElementById('appLangSelect').addEventListener('change', (e) => applyLanguage(e.target.value));
    document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
    document.getElementById('modalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modalBackdrop') closeModal();
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
      currentUser = null;
      localStorage.removeItem(SESSION_KEY);
      document.getElementById('appShell').classList.add('hidden');
      document.getElementById('loginScreen').classList.remove('hidden');
    });

    function normalizePin(str) {
      if (!str) return '';
      return String(str)
        .trim()
        .replace(/[٠-٩]/g, (d) => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
        .replace(/[۰-۹]/g, (d) => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
    }

    function cleanLoginStr(str) {
      if (!str) return '';
      return String(str).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function matchUser(users, employees, inputUser, inputPin) {
      const uClean = cleanLoginStr(inputUser);
      const pNorm = normalizePin(inputPin);
      if (!uClean || !pNorm) return null;

      return (users || []).find((x) => {
        if (x.disabled) return false;
        if (normalizePin(x.pin) !== pNorm) return false;
        // Direct match on username (case-insensitive, no dashes)
        if (cleanLoginStr(x.username) === uClean) return true;
        // Match by employee code (e.g. FT-107 entered instead of ft107)
        if (x.empId) {
          const emp = (employees || []).find((e) => e.id === x.empId);
          if (emp && cleanLoginStr(emp.code) === uClean) return true;
        }
        return false;
      });
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawU = document.getElementById('loginUsername').value;
      const rawP = document.getElementById('loginPin').value;
      const errEl = document.getElementById('loginError');

      // 1. Check local state in memory
      let found = matchUser(state.users, state.employees, rawU, rawP);

      // 2. If not found in memory, always fetch latest state from server before failing
      if (!found) {
        let serverError = false;
        try {
          const res = await fetch('/api/state?t=' + Date.now(), { cache: 'no-store' });
          if (res.ok) {
            state = await res.json();
            found = matchUser(state.users, state.employees, rawU, rawP);
          } else {
            serverError = true;
          }
        } catch (_) {
          serverError = true;
        }

        if (!found) {
          if (serverError) {
            errEl.textContent = '⚠️ تعذر الاتصال بسيرفر التطبيق! يرجى التأكد من تشغيل السيرفر على جهاز الكمبيوتر (Start Fotat HR) والاتصال بنفس الشبكة.';
          } else {
            errEl.textContent = t('invalidLogin');
          }
          errEl.classList.remove('hidden');
          return;
        }
      }

      errEl.classList.add('hidden');
      loginSuccess(found);
    });

    const savedUid = localStorage.getItem(SESSION_KEY);
    if (savedUid) {
      const found = state.users.find((x) => x.id === savedUid && !x.disabled);
      if (found) loginSuccess(found);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      document.getElementById('installAppBtn').classList.remove('hidden');
    });

    document.getElementById('installAppBtn').addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt = null;
        document.getElementById('installAppBtn').classList.add('hidden');
      } else {
        const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIos) {
          alert('لتثبيت التطبيق على الآيفون:\n1. اضغط على زر المشاركة (⬆️) أسفل الشاشة\n2. اختر "إضافة إلى الصفحة الرئيسية (Add to Home Screen)"');
        } else {
          alert('لتثبيت التطبيق على الموبايل:\n1. اضغط على الثلاث نقط (⋮) أعلى المتصفح\n2. اختر "تثبيت التطبيق (Install app)" أو "إضافة إلى الشاشة الرئيسية"');
        }
      }
    });
  }

  init();
})();
