(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    mode: $('mode'),
    phase: $('phase'),
    singleValue: $('singleValue'),
    singleUnit: $('singleUnit'),
    rangeStart: $('rangeStart'),
    rangeEnd: $('rangeEnd'),
    rangeStep: $('rangeStep'),
    rangeUnit: $('rangeUnit'),
    btnCalc: $('btnCalc'),
    btnCsv: $('btnCsv'),
    statusLine: $('statusLine'),
    resultBody: $('resultBody'),
    resultMeta: $('resultMeta'),
    rangeBody: $('rangeBody'),
    tableMeta: $('tableMeta')
  };

  const MW_WATER = 18.01528; // g/mol, numerically equivalent to lbm/lb-mole.
  const T_MIN_K = 273.16;
  const T_CRITICAL_K = 647.096;
  const P_MIN_MPA = 0.000611657;
  const P_CRITICAL_MPA = 22.064;
  const T_REF_20C_K = 293.15;
  const P_REF_1ATM_MPA = 0.101325;

  const DEFAULTS = {
    P: {
      single: '14.6959',
      start: '0.088833',
      end: '3000',
      step: '200',
      unit: 'psia',
      status: 'Pressure mode: saturation pressure in psia.'
    },
    T: {
      single: '211.9536',
      start: '32.02',
      end: '700',
      step: '25',
      unit: 'degF',
      status: 'Temperature mode: saturation temperature in degF.'
    }
  };

  let lastRangeRows = [];

  const U = {
    K_from_F: (F) => (Number(F) + 459.67) * 5 / 9,
    F_from_K: (K) => Number(K) * 9 / 5 - 459.67,

    MPa_from_psia: (psia) => Number(psia) * 0.006894757293168361,
    psia_from_MPa: (MPa) => Number(MPa) / 0.006894757293168361,

    lbmft3_from_kgm3: (rho) => Number(rho) * 0.0624279605761,
    ft3lbm_from_m3kg: (v) => Number(v) * 16.01846337396,
    fts_from_ms: (w) => Number(w) * 3.280839895013123,

    Btu_lbmol_from_kJkg: (q) => Number(q) * MW_WATER * 0.45359237 * 0.9478171203133172,
    Btu_lbmol_R_from_kJkgK: (q) => Number(q) * MW_WATER * 0.45359237 * 0.9478171203133172 * (5 / 9),

    lbin_from_mNm: (sigma) => Number(sigma) * 5.71014716277e-6,
    F_psia_from_K_MPa: (muJT) => Number(muJT) * (9 / 5) / 145.03773773020923
  };

  function checkLibrary() {
    return !!(window.NeutriumJS &&
      NeutriumJS.thermo &&
      NeutriumJS.thermo.IAPWS97 &&
      NeutriumJS.thermo.IAPWS97.PT);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function formatNumber(value, digits = 6) {
    if (!Number.isFinite(value)) return '--';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-4)) {
      return value.toExponential(Math.max(2, digits - 1));
    }
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    });
  }

  function readNumber(input, label) {
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a valid number.`);
    }
    return value;
  }

  function pressureRangeText() {
    return `${formatNumber(U.psia_from_MPa(P_MIN_MPA), 6)} to ${formatNumber(U.psia_from_MPa(P_CRITICAL_MPA), 2)} psia`;
  }

  function temperatureRangeText() {
    return `${formatNumber(U.F_from_K(T_MIN_K), 3)} to ${formatNumber(U.F_from_K(T_CRITICAL_K), 3)} degF`;
  }

  function updateModeUI() {
    const settings = DEFAULTS[els.mode.value];
    els.singleUnit.value = settings.unit;
    els.rangeUnit.value = settings.unit;
    els.singleValue.value = settings.single;
    els.rangeStart.value = settings.start;
    els.rangeEnd.value = settings.end;
    els.rangeStep.value = settings.step;
    els.statusLine.textContent = settings.status;
  }

  function getSaturationStateFromInput(mode, inputValue, phase) {
    if (!checkLibrary()) {
      throw new Error('Property library failed to load. Check the internet connection and reload the page.');
    }

    const PT = NeutriumJS.thermo.IAPWS97.PT;

    let P;
    let T;

    if (mode === 'P') {
      P = U.MPa_from_psia(inputValue);
      if (!(P >= P_MIN_MPA && P <= P_CRITICAL_MPA)) {
        throw new Error(`Pressure is outside the saturation range (${pressureRangeText()}).`);
      }
      T = PT.r4_P_Tsat(P);
    } else {
      T = U.K_from_F(inputValue);
      if (!(T >= T_MIN_K && T <= T_CRITICAL_K)) {
        throw new Error(`Temperature is outside the saturation range (${temperatureRangeText()}).`);
      }
      P = PT.r4_T_Psat(T);
    }

    if (Math.abs(T - T_CRITICAL_K) < 1e-7) {
      throw new Error('At the critical point, liquid and vapor saturation branches are not distinct.');
    }

    let state;
    if (T <= 623.15) {
      state = phase === 'liquid' ? PT.r1(P, T) : PT.r2(P, T);
    } else {
      state = solveRegion3SaturationState(PT, P, T, phase);
    }

    const muJT = estimateJouleThomson(PT, state.p, state.t, state, phase);
    return toDisplayState(state, muJT, phase);
  }

  function solveSinglePhasePT(PT, pressure, temperature, phase) {
    if (temperature <= 623.15) {
      return phase === 'liquid' ? PT.r1(pressure, temperature) : PT.r2(pressure, temperature);
    }
    return solveRegion3SaturationState(PT, pressure, temperature, phase);
  }

  function solveRegion3SaturationState(PT, pressure, temperature, phase) {
    const rhoCritical = 322;
    const ranges = phase === 'liquid'
      ? [[rhoCritical, 760], [760, 1200]]
      : [[1, rhoCritical]];

    for (const [minRho, maxRho] of ranges) {
      const rho = findRegion3DensityRoot(PT, pressure, temperature, minRho, maxRho);
      if (Number.isFinite(rho)) return PT.r3(pressure, temperature, rho);
    }

    return PT.r3(pressure, temperature);
  }

  function findRegion3DensityRoot(PT, pressure, temperature, minRho, maxRho) {
    const steps = 360;
    let prevRho = minRho;
    let prevResidual = region3PressureResidual(PT, pressure, temperature, prevRho);

    for (let i = 1; i <= steps; i += 1) {
      const rho = minRho + (maxRho - minRho) * i / steps;
      const residual = region3PressureResidual(PT, pressure, temperature, rho);

      if (!Number.isFinite(prevResidual)) {
        prevRho = rho;
        prevResidual = residual;
        continue;
      }

      if (Number.isFinite(residual) && prevResidual * residual <= 0) {
        return bisectRegion3DensityRoot(PT, pressure, temperature, prevRho, rho, prevResidual, residual);
      }

      prevRho = rho;
      prevResidual = residual;
    }

    return NaN;
  }

  function bisectRegion3DensityRoot(PT, pressure, temperature, lowRho, highRho, lowResidual, highResidual) {
    let lo = lowRho;
    let hi = highRho;
    let fLo = lowResidual;
    let fHi = highResidual;

    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      const fMid = region3PressureResidual(PT, pressure, temperature, mid);

      if (!Number.isFinite(fMid)) break;
      if (Math.abs(fMid) < 1e-10) return mid;

      if (fLo * fMid <= 0) {
        hi = mid;
        fHi = fMid;
      } else {
        lo = mid;
        fLo = fMid;
      }

      if (Math.abs(hi - lo) < 1e-8 || Math.abs(fHi - fLo) < 1e-12) break;
    }

    return (lo + hi) / 2;
  }

  function region3PressureResidual(PT, pressure, temperature, rho) {
    try {
      return PT.r3(pressure, temperature, rho).p - pressure;
    } catch (_err) {
      return NaN;
    }
  }

  function estimateJouleThomson(PT, pressure, temperature, state, phase) {
    const dT = Math.max(1e-4, temperature * 1e-6);
    try {
      let dvdT;
      if (phase === 'liquid') {
        const lowerT = Math.max(T_MIN_K, temperature - dT);
        if (lowerT === temperature) return NaN;
        const lower = PT.solve(pressure, lowerT);
        dvdT = (state.v - lower.v) / (temperature - lowerT);
      } else {
        const upperT = Math.min(T_CRITICAL_K - 1e-6, temperature + dT);
        if (upperT === temperature) return NaN;
        const upper = PT.solve(pressure, upperT);
        dvdT = (upper.v - state.v) / (upperT - temperature);
      }

      if (!Number.isFinite(dvdT) || !Number.isFinite(state.cp) || state.cp === 0) return NaN;
      return ((temperature * dvdT - state.v) / state.cp) * 1000;
    } catch (_err) {
      return NaN;
    }
  }

  function toDisplayState(state, muJT_K_MPa, phase) {
    const sigma = Number.isFinite(state.sig) ? state.sig : state.sigma;
    const specificGravity20C = state.rho / getWaterReferenceDensity20C();
    const raw = {
      temperature_F: U.F_from_K(state.t),
      pressure_psia: U.psia_from_MPa(state.p),
      density_lbm_ft3: U.lbmft3_from_kgm3(state.rho),
      specificGravity_20_20C: specificGravity20C,
      volume_ft3_lbm: U.ft3lbm_from_m3kg(state.v),
      internalEnergy_Btu_lbmol: U.Btu_lbmol_from_kJkg(state.u),
      enthalpy_Btu_lbmol: U.Btu_lbmol_from_kJkg(state.h),
      entropy_Btu_lbmol_R: U.Btu_lbmol_R_from_kJkgK(state.s),
      cv_Btu_lbmol_R: U.Btu_lbmol_R_from_kJkgK(state.cv),
      cp_Btu_lbmol_R: U.Btu_lbmol_R_from_kJkgK(state.cp),
      soundSpeed_ft_s: U.fts_from_ms(state.w),
      jouleThomson_F_psia: U.F_psia_from_K_MPa(muJT_K_MPa),
      viscosity_cP: state.mu,
      thermalConductivity_W_mK: state.k,
      surfaceTension_lb_in: U.lbin_from_mNm(sigma),
      phase
    };

    return {
      'Temperature (degF)': raw.temperature_F,
      'Pressure (psia)': raw.pressure_psia,
      'Density (lbm/ft^3)': raw.density_lbm_ft3,
      'Specific Gravity 20/20C': raw.specificGravity_20_20C,
      'Volume (ft^3/lbm)': raw.volume_ft3_lbm,
      'Internal Energy (Btu/lb-mole)': raw.internalEnergy_Btu_lbmol,
      'Enthalpy (Btu/lb-mole)': raw.enthalpy_Btu_lbmol,
      'Entropy (Btu/lb-mole*R)': raw.entropy_Btu_lbmol_R,
      'Cv (Btu/lb-mole*R)': raw.cv_Btu_lbmol_R,
      'Cp (Btu/lb-mole*R)': raw.cp_Btu_lbmol_R,
      'Sound Spd. (ft/s)': raw.soundSpeed_ft_s,
      'Joule-Thomson (degF/psia)': raw.jouleThomson_F_psia,
      'Viscosity (cP)': raw.viscosity_cP,
      'Therm. Cond. (W/m*K)': raw.thermalConductivity_W_mK,
      'Surf. Tension (lb/in)': raw.surfaceTension_lb_in,
      Phase: raw.phase,
      _raw: raw
    };
  }

  function getWaterReferenceDensity20C() {
    const PT = NeutriumJS.thermo.IAPWS97.PT;
    return PT.r1(P_REF_1ATM_MPA, T_REF_20C_K).rho;
  }

  function renderSingleResult(result, mode, inputValue) {
    const rows = Object.entries(result)
      .filter(([key]) => key !== '_raw')
      .map(([key, value]) => {
        const isText = typeof value === 'string';
        const display = isText ? escapeHtml(value) : formatNumber(value, 8);
        return `<tr><td>${escapeHtml(key)}</td><td class="mono">${display}</td></tr>`;
      })
      .join('');

    els.resultBody.innerHTML = rows;
    els.resultMeta.textContent = `Mode: ${mode === 'P' ? 'Pressure input' : 'Temperature input'} | Input: ${inputValue} ${mode === 'P' ? 'psia' : 'degF'} | Phase: ${result.Phase}`;
  }

  function buildRangeValues(start, end, step) {
    const out = [];
    const maxRows = 601;

    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step === 0) {
      throw new Error('Start, end, and increment must be valid numbers, and increment cannot be zero.');
    }

    const directionOk = end >= start ? step > 0 : step < 0;
    if (!directionOk) {
      throw new Error('Increment direction does not move from start toward end.');
    }

    let x = start;
    for (let i = 0; i < maxRows; i += 1) {
      if ((step > 0 && x > end + 1e-12) || (step < 0 && x < end - 1e-12)) break;
      out.push(Number(x.toPrecision(14)));
      x += step;
    }

    if (out.length === 0) throw new Error('No range values generated.');
    if (out.length >= maxRows) throw new Error('Too many rows requested. Reduce the range or increase the increment.');

    return out;
  }

  function renderRangeTable(rows, mode, phase) {
    lastRangeRows = rows;
    const html = rows.map((row) => {
      const r = row._raw;
      return `
        <tr>
          <td class="mono">${formatNumber(r.temperature_F, 6)}</td>
          <td class="mono">${formatNumber(r.pressure_psia, 6)}</td>
          <td class="mono">${formatNumber(r.density_lbm_ft3, 6)}</td>
          <td class="mono">${formatNumber(r.specificGravity_20_20C, 8)}</td>
          <td class="mono">${formatNumber(r.volume_ft3_lbm, 8)}</td>
          <td class="mono">${formatNumber(r.internalEnergy_Btu_lbmol, 6)}</td>
          <td class="mono">${formatNumber(r.enthalpy_Btu_lbmol, 6)}</td>
          <td class="mono">${formatNumber(r.entropy_Btu_lbmol_R, 8)}</td>
          <td class="mono">${formatNumber(r.cv_Btu_lbmol_R, 8)}</td>
          <td class="mono">${formatNumber(r.cp_Btu_lbmol_R, 8)}</td>
          <td class="mono">${formatNumber(r.soundSpeed_ft_s, 6)}</td>
          <td class="mono">${formatNumber(r.jouleThomson_F_psia, 10)}</td>
          <td class="mono">${formatNumber(r.viscosity_cP, 8)}</td>
          <td class="mono">${formatNumber(r.thermalConductivity_W_mK, 8)}</td>
          <td class="mono">${formatNumber(r.surfaceTension_lb_in, 10)}</td>
          <td>${escapeHtml(r.phase)}</td>
        </tr>`;
    }).join('');

    els.rangeBody.innerHTML = html;
    els.tableMeta.textContent = `${rows.length} rows | Mode: ${mode === 'P' ? 'Pressure input' : 'Temperature input'} | Phase: ${phase}`;
  }

  function csvValue(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(rows) {
    const headers = [
      'Temperature (F)',
      'Pressure (psia)',
      'Density (lbm/ft3)',
      'Specific Gravity 20/20C',
      'Volume (ft3/lbm)',
      'Internal Energy (Btu/lb-mole)',
      'Enthalpy (Btu/lb-mole)',
      'Entropy (Btu/lb-mole*R)',
      'Cv (Btu/lb-mole*R)',
      'Cp (Btu/lb-mole*R)',
      'Sound Spd. (ft/s)',
      'Joule-Thomson (F/psia)',
      'Viscosity (cP)',
      'Therm. Cond. (W/m*K)',
      'Surf. Tension (lb/in)',
      'Phase'
    ];

    const lines = [headers.map(csvValue).join(',')];
    for (const row of rows) {
      const r = row._raw;
      lines.push([
        r.temperature_F,
        r.pressure_psia,
        r.density_lbm_ft3,
        r.specificGravity_20_20C,
        r.volume_ft3_lbm,
        r.internalEnergy_Btu_lbmol,
        r.enthalpy_Btu_lbmol,
        r.entropy_Btu_lbmol_R,
        r.cv_Btu_lbmol_R,
        r.cp_Btu_lbmol_R,
        r.soundSpeed_ft_s,
        r.jouleThomson_F_psia,
        r.viscosity_cP,
        r.thermalConductivity_W_mK,
        r.surfaceTension_lb_in,
        r.phase
      ].map(csvValue).join(','));
    }
    return lines.join('\n');
  }

  function downloadCsv() {
    if (!lastRangeRows.length) {
      els.statusLine.innerHTML = '<span class="warn">Run Calculate first before downloading CSV.</span>';
      return;
    }

    const blob = new Blob([toCsv(lastRangeRows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `water_saturation_${els.mode.value === 'P' ? 'pressure' : 'temperature'}_${els.phase.value}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function calculateSingle() {
    try {
      const inputValue = readNumber(els.singleValue, 'Input value');
      const result = getSaturationStateFromInput(els.mode.value, inputValue, els.phase.value);
      renderSingleResult(result, els.mode.value, els.singleValue.value);
      return { ok: true, message: 'Single point calculated.' };
    } catch (err) {
      const message = escapeHtml(err.message);
      els.resultBody.innerHTML = `<tr><td colspan="2" class="empty err">${message}</td></tr>`;
      els.resultMeta.textContent = '';
      return { ok: false, message: err.message };
    }
  }

  function generateRangeTable() {
    try {
      const values = buildRangeValues(
        readNumber(els.rangeStart, 'Start'),
        readNumber(els.rangeEnd, 'End'),
        readNumber(els.rangeStep, 'Increment')
      );

      const rows = values.map((val) => getSaturationStateFromInput(els.mode.value, val, els.phase.value));
      renderRangeTable(rows, els.mode.value, els.phase.value);
      return { ok: true, rows: rows.length, message: `Generated ${rows.length} saturation rows.` };
    } catch (err) {
      const message = escapeHtml(err.message);
      els.rangeBody.innerHTML = `<tr><td colspan="16" class="empty err">${message}</td></tr>`;
      els.tableMeta.textContent = '';
      lastRangeRows = [];
      return { ok: false, message: err.message };
    }
  }

  function calculateAll() {
    const single = calculateSingle();
    const range = generateRangeTable();

    if (single.ok && range.ok) {
      els.statusLine.innerHTML = `<span class="ok">Calculation completed:</span> single point and ${range.rows} table rows updated.`;
      return;
    }

    if (single.ok) {
      els.statusLine.innerHTML = `<span class="warn">Single point calculated.</span> Range table needs attention: ${escapeHtml(range.message)}`;
      return;
    }

    if (range.ok) {
      els.statusLine.innerHTML = `<span class="warn">Range table generated.</span> Single point needs attention: ${escapeHtml(single.message)}`;
      return;
    }

    els.statusLine.innerHTML = `<span class="err">Calculation failed.</span> ${escapeHtml(single.message)} Range: ${escapeHtml(range.message)}`;
  }

  els.mode.addEventListener('change', updateModeUI);
  els.btnCalc.addEventListener('click', calculateAll);
  els.btnCsv.addEventListener('click', downloadCsv);

  updateModeUI();
})();
