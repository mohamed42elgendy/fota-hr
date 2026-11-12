window.FOTAT_PAYROLL = {
  SHIFTS: {
    morning: { code: 'morning', start: '06:00', end: '16:00', hours: 10, labelKey: 'shiftMorning' },
    evening: { code: 'evening', start: '14:00', end: '00:00', hours: 10, labelKey: 'shiftEvening' },
    night: { code: 'night', start: '20:00', end: '06:00', hours: 10, labelKey: 'shiftNight' },
    off: { code: 'off', start: null, end: null, hours: 0, labelKey: 'shiftOff' }
  },

  DAY_KEYS: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],

  parseTimeToMinutes(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  },

  computeShiftHours(start, end) {
    if (!start || !end) return 0;
    let s = this.parseTimeToMinutes(start);
    let e = this.parseTimeToMinutes(end);
    if (e <= s) e += 24 * 60;
    return Number(((e - s) / 60).toFixed(2));
  },

  normalizeShift(raw) {
    if (!raw) {
      return { off: false, start: '06:00', end: '16:00', hours: 10 };
    }
    if (typeof raw === 'string') {
      const preset = this.SHIFTS[raw] || this.SHIFTS.morning;
      return {
        off: preset.code === 'off',
        start: preset.start,
        end: preset.end,
        hours: preset.hours
      };
    }
    if (raw.off) {
      return { off: true, start: null, end: null, hours: 0 };
    }
    const start = raw.start || '06:00';
    const end = raw.end || '16:00';
    return {
      off: false,
      start,
      end,
      hours: this.computeShiftHours(start, end)
    };
  },

  getShiftForDate(employee, schedules, dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dayKey = this.DAY_KEYS[d.getDay()];
    const deptSched = schedules[employee.deptId] || {};
    const empSched = deptSched[employee.id] || {};
    return this.normalizeShift(empSched[dayKey]);
  },

  calculateAttendanceMetrics(record, shift) {
    if (!record || !record.checkIn || !shift || shift.off || !shift.start) {
      return { lateMinutes: 0, overtimeMinutes: 0, workedMinutes: 0 };
    }
    const inDate = new Date(record.checkIn);
    const inMins = inDate.getHours() * 60 + inDate.getMinutes();
    const shiftStartMins = this.parseTimeToMinutes(shift.start);
    let shiftEndMins = this.parseTimeToMinutes(shift.end);
    if (shiftEndMins <= shiftStartMins) shiftEndMins += 24 * 60;

    let adjInMins = inMins;
    if (shiftStartMins >= 18 * 60 && inMins < 12 * 60) {
      adjInMins += 24 * 60;
    }

    const rawLate = adjInMins - shiftStartMins;
    const lateMinutes = rawLate > 10 ? rawLate : 0;

    let workedMinutes = 0;
    let overtimeMinutes = 0;
    if (record.checkOut) {
      const outDate = new Date(record.checkOut);
      const diffMs = outDate.getTime() - inDate.getTime();
      workedMinutes = Math.max(0, Math.round(diffMs / 60000));
      const expectedMins = shift.hours * 60;
      if (workedMinutes > expectedMins + 15) {
        overtimeMinutes = workedMinutes - expectedMins;
      }
    }
    return { lateMinutes, overtimeMinutes, workedMinutes };
  },

  computeMonthlyPayroll(employee, attendanceLogs, schedules, yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    let totalLateMins = 0;
    let totalOvertimeMins = 0;
    let absentDays = 0;
    let presentDays = 0;

    const empLogs = {};
    attendanceLogs
      .filter((l) => l.employeeId === employee.id && l.date.startsWith(yearMonth))
      .forEach((l) => {
        empLogs[l.date] = l;
      });

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${yearMonth}-${String(day).padStart(2, '0')}`;
      if (dateStr > todayStr) break;

      const shift = this.getShiftForDate(employee, schedules, dateStr);
      if (shift.off) continue;

      const log = empLogs[dateStr];
      if (!log || !log.checkIn) {
        if (dateStr < todayStr) absentDays += 1;
      } else {
        presentDays += 1;
        const m = this.calculateAttendanceMetrics(log, shift);
        totalLateMins += m.lateMinutes;
        totalOvertimeMins += m.overtimeMinutes;
      }
    }

    const lateHours = Number((totalLateMins / 60).toFixed(2));
    const overtimeHours = Number((totalOvertimeMins / 60).toFixed(2));
    const hourlyRate = employee.baseSalary / (26 * 10);

    const lateDeduction = Math.round(lateHours * hourlyRate);
    const absenceDeduction = Math.round(absentDays * 10 * hourlyRate);
    const overtimePay = Math.round(overtimeHours * hourlyRate * 1.25);

    const advancesTotal = (employee.advances || [])
      .filter((a) => a.date.startsWith(yearMonth))
      .reduce((sum, a) => sum + Number(a.amount || 0), 0);

    const penaltiesTotal = (employee.penalties || [])
      .filter((p) => p.date.startsWith(yearMonth))
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const totalDeductions = lateDeduction + absenceDeduction + advancesTotal + penaltiesTotal;
    const netSalary = Math.max(0, Math.round(employee.baseSalary + overtimePay - totalDeductions));

    return {
      presentDays,
      absentDays,
      lateHours,
      overtimeHours,
      lateDeduction,
      absenceDeduction,
      advancesTotal,
      penaltiesTotal,
      totalDeductions,
      overtimePay,
      netSalary
    };
  }
};
