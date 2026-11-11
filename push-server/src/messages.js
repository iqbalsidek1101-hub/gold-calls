'use strict';

const { callName } = require('../../push-shared');

const SCORE_LAG = 'Semakan setiap 10 minit, 08:00–21:50 MYT, bukan harga live.';
const ANALYSIS_LAG = 'Ikut analisis penuh ~30 minit, bukan harga live.';

function finiteR(call) {
  const value = call && call.r_result;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function rLabel(value) {
  return (value > 0 ? '+' : '') + value.toFixed(2) + 'R';
}

function stampOf(call, doc) {
  const raw = (call && call.scored_myt) || (doc && (doc.generated_myt || doc.last_updated)) || '';
  return String(raw).trim();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '—';
}

function displayName(call) {
  return callName(call);
}

function messageFor(category, call, doc) {
  const name = displayName(call);
  const when = stampOf(call, doc);
  const r = finiteR(call);
  if (category === 'new_call') {
    const dir = String(call.direction || '').toUpperCase();
    return {
      title: 'Call baru',
      body: name + ' · ' + dir + ' zon ' + money(call.entry_lo) + '–' + money(call.entry_hi) + '. Call analisis sahaja, bukan order broker. ' + ANALYSIS_LAG
    };
  }
  if (category === 'entry') {
    const status = String(call.status || 'FILLED').toUpperCase();
    return {
      title: 'Entry tersentuh (simulasi)',
      body: name + ' · simulasi call: zon entry tersentuh dalam calls.json (status ' + status + '). Bukan order broker, bukan fill akaun. ' + SCORE_LAG
    };
  }
  if (category === 'tp') {
    let detail;
    if (r == null || !when) {
      detail = 'calls.json tandakan TP. R tak dipaparkan (data tak lengkap, bukan pengesahan menang).';
    } else if (r <= 0) {
      detail = 'status TP tapi R ' + rLabel(r) + ' dalam calls.json (' + when + ' MYT). Bukan pengesahan menang.';
    } else {
      detail = 'status TP. ' + rLabel(r) + ' dalam calls.json (' + when + ' MYT).';
    }
    return { title: 'TP dalam calls.json', body: name + ' · ' + detail + ' ' + SCORE_LAG };
  }
  if (category === 'sl') {
    const rBit = r == null
      ? 'R tak ada dalam calls.json.'
      : 'R ' + rLabel(r) + ' dalam calls.json' + (when ? ' (' + when + ' MYT)' : '') + '.';
    return {
      title: 'SL dalam calls.json',
      body: name + ' · status SL. ' + rBit + ' ' + SCORE_LAG
    };
  }
  return {
    title: 'Ujian Charlie Calls',
    body: 'Push latar belakang berjaya. Ni bukan call dagangan dan bukan amaran dalam halaman.'
  };
}

module.exports = {
  SCORE_LAG,
  ANALYSIS_LAG,
  finiteR,
  messageFor
};
