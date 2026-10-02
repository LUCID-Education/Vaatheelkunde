/*!
 * LUCID Availability – coordinator.js (coördinatorpagina)
 * ------------------------------------------------------------------
 * - Meerdere JSON-bestanden laden (drag & drop of selecteren)
 * - Elk bestand afzonderlijk valideren; één fout bestand breekt niets
 * - Dubbele personen herkennen (nieuwste versie wint)
 * - Vergaderduur + filters → matcher.analyze → resultaten + heatmap
 *
 * PRIVACY: bestanden worden enkel met FileReader/Blob.text() in het geheugen
 * van de browser gelezen. Er is geen enkele netwerkaanvraag met deze gegevens
 * en er wordt niets in localStorage bewaard.
 */
(function () {
  'use strict';

  var core = window.LUCID.core;
  var matcher = window.LUCID.matcher;
  var ui = window.LUCID.ui;
  var el = ui.el, icon = ui.icon;
  var N = core.SLOTS_PER_DAY;

  var MAX_FILES = 60;
  var TYPE_INFO = {
    physical: { label: 'Iedereen fysiek', badge: 'badge-physical', icon: 'user' },
    mixed: { label: 'Iedereen beschikbaar: fysiek of online', badge: 'badge-mixed', icon: 'users' },
    online: { label: 'Iedereen alleen online', badge: 'badge-online', icon: 'laptop' },
    partial: { label: 'Niet iedereen', badge: 'badge-partial', icon: 'users' }
  };

  var participants = [];
  var searched = false;
  var lastAnalysis = null;
  var tip;

  function $(id) { return document.getElementById(id); }

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    tip = ui.floatTip();
    buildControls();
    bindFiles();
    bindInvite();
    $('searchBtn').addEventListener('click', function () { searched = true; runSearch(true); });
    $('copyResults').addEventListener('click', copyResults);
    $('removeAll').addEventListener('click', function () {
      ui.confirmDialog({ title: 'Alle deelnemers verwijderen?', body: 'Alle geladen bestanden worden uit deze pagina verwijderd.', okText: 'Verwijderen', danger: true })
        .then(function (okay) { if (okay) { participants = []; onParticipantsChanged(); } });
    });
    onParticipantsChanged();
  }

  /* =====================================================================
   * Bedieningselementen
   * ===================================================================== */
  function buildControls() {
    var dur = $('duration');
    for (var m = 15; m <= 240; m += 15) dur.appendChild(el('option', { value: String(m), text: core.formatMeetingDuration(m), selected: m === 60 }));

    var tf = $('timeFrom'), tt = $('timeTo');
    for (var i = 0; i < N; i++) tf.appendChild(el('option', { value: String(i), text: core.slotToTime(i), selected: i === 32 }));
    for (var j = 1; j <= N; j++) tt.appendChild(el('option', { value: String(j), text: core.slotToTime(j), selected: j === 88 }));

    var wd = $('weekdays');
    core.WEEKDAY_NAMES.forEach(function (name, idx) {
      wd.appendChild(el('label', { class: 'check-pill' }, [
        el('input', { type: 'checkbox', value: String(idx + 1), checked: true }),
        name.charAt(0).toUpperCase() + name.slice(1)
      ]));
    });

    ['duration', 'minPeople', 'sortBy', 'dateFrom', 'dateTo', 'timeFrom', 'timeTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { if (searched) runSearch(false); });
    });
    [wd, $('types')].forEach(function (g) {
      g.addEventListener('change', function () { if (searched) runSearch(false); });
    });
  }

  function readOptions() {
    var weekdays = Array.prototype.filter.call($('weekdays').querySelectorAll('input'), function (c) { return c.checked; })
      .map(function (c) { return +c.value; });
    var types = {};
    $('types').querySelectorAll('input').forEach(function (c) { types[c.value] = c.checked; });
    return {
      durationMinutes: +$('duration').value,
      dateFrom: $('dateFrom').value || undefined,
      dateTo: $('dateTo').value || undefined,
      timeFrom: +$('timeFrom').value,
      timeTo: +$('timeTo').value,
      weekdays: weekdays,
      types: types,
      minParticipants: +$('minPeople').value || participants.length,
      sort: $('sortBy').value
    };
  }

  /* =====================================================================
   * Bestanden inlezen
   * ===================================================================== */
  function bindFiles() {
    var dz = $('dropzone'), input = $('fileInput');
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
    // Voorkom dat de browser een bestand opent als het naast de dropzone wordt losgelaten.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('clearLog').addEventListener('click', function () { ui.clear($('fileLog')); $('clearLog').hidden = true; });
    $('loadSamples').addEventListener('click', loadSamples);
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length > MAX_FILES) {
      logEntry('Te veel bestanden', 'err', ['Maximaal ' + MAX_FILES + ' bestanden per keer.']);
      return;
    }
    Promise.all(files.map(readOne)).then(function (items) {
      var summary = { added: 0, replaced: 0, failed: 0, skipped: 0 };
      items.forEach(function (it) { ingest(it, summary); });
      onParticipantsChanged();
      var parts = [];
      if (summary.added) parts.push(summary.added + ' geladen');
      if (summary.replaced) parts.push(summary.replaced + ' bijgewerkt');
      if (summary.skipped) parts.push(summary.skipped + ' overgeslagen');
      if (summary.failed) parts.push(summary.failed + ' met fouten');
      ui.toast(parts.join(' · ') || 'Geen wijzigingen', { icon: summary.failed ? 'alert' : 'check' });
    });
  }

  function readOne(file) {
    var name = String(file.name || 'bestand').slice(0, 120);
    if (file.size > core.MAX_FILE_BYTES) return Promise.resolve({ name: name, result: { ok: false, errors: ['Bestand is te groot (max. 2 MB).'], warnings: [] } });
    if (!/\.json$/i.test(name) && file.type && file.type.indexOf('json') < 0) {
      return Promise.resolve({ name: name, result: { ok: false, errors: ['Dit is geen .json-bestand.'], warnings: [] } });
    }
    var reader = file.text ? file.text() : new Promise(function (res, rej) {
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file);
    });
    return reader.then(function (text) { return { name: name, result: core.parseAndValidate(text) }; },
      function () { return { name: name, result: { ok: false, errors: ['Bestand kon niet gelezen worden.'], warnings: [] } }; });
  }

  function ingest(item, summary) {
    var r = item.result;
    if (!r.ok) {
      summary.failed++;
      logEntry(item.name, 'err', r.errors);
      return;
    }
    var p = r.data;
    p.fileName = item.name;
    var warnings = r.warnings.slice();
    var idx = -1;
    for (var i = 0; i < participants.length; i++) if (participants[i].key === p.key) { idx = i; break; }
    if (idx >= 0) {
      var old = participants[idx];
      var newer = p.submittedAt && (!old.submittedAt || Date.parse(p.submittedAt) > Date.parse(old.submittedAt));
      if (newer) {
        participants[idx] = p;
        summary.replaced++;
        warnings.unshift(p.fullName + ' was al geladen. De nieuwere versie (' + formatStamp(p.submittedAt) + ') vervangt de oudere.');
        logEntry(item.name, 'warn', warnings, p.fullName);
      } else {
        summary.skipped++;
        logEntry(item.name, 'warn', [p.fullName + ' is al geladen met een even recente of nieuwere versie. Dit bestand werd overgeslagen.'], p.fullName);
      }
      return;
    }
    participants.push(p);
    summary.added++;
    logEntry(item.name, warnings.length ? 'warn' : 'ok', warnings, p.fullName);
  }

  function logEntry(fileName, kind, messages, who) {
    var log = $('fileLog');
    var ic = kind === 'err' ? 'x' : kind === 'warn' ? 'alert' : 'check';
    var color = kind === 'err' ? 'var(--danger)' : kind === 'warn' ? 'var(--warning)' : 'var(--success)';
    var li = el('li', { class: kind === 'ok' ? '' : kind }, [
      el('div', { class: 'fn', attrs: { title: fileName } }, [
        el('span', { style: { color: color } }, icon(ic)),
        el('span', { class: 'fn-text' }, [
          el('span', { text: who || fileName }),
          who ? el('span', { class: 'fn-file', text: fileName }) : null
        ])
      ])
    ]);
    if (messages && messages.length) li.appendChild(el('ul', {}, messages.map(function (m) { return el('li', { text: m }); })));
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 30) log.removeChild(log.lastChild);
    $('clearLog').hidden = false;
  }

  function loadSamples() {
    fetch('voorbeeldgegevens.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error();
        handleFiles(list.map(function (it) {
          return new File([JSON.stringify(it.document)], String(it.name || 'voorbeeld.json'), { type: 'application/json' });
        }));
      })
      .catch(function () {
        ui.toast('Voorbeeldgegevens laden werkt alleen via GitHub Pages of een lokale webserver.', { icon: 'info', duration: 5000 });
      });
  }

  /* =====================================================================
   * Deelnemers
   * ===================================================================== */
  function onParticipantsChanged() {
    participants.sort(function (a, b) { return a.fullName.localeCompare(b.fullName, 'nl', { sensitivity: 'base' }); });
    renderParticipants();
    var cov = matcher.computeCoverage(participants);
    // Datumfilters op de gemeenschappelijke periode zetten
    var df = $('dateFrom'), dt = $('dateTo');
    if (cov.commonDates.length) {
      var first = cov.commonDates[0], last = cov.commonDates[cov.commonDates.length - 1];
      df.min = dt.min = first; df.max = dt.max = last;
      if (!df.value || df.value < first || df.value > last) df.value = first;
      if (!dt.value || dt.value > last || dt.value < first) dt.value = last;
    } else { df.value = dt.value = ''; }

    buildMinPeople();
    var has = participants.length > 0;
    $('searchBtn').disabled = !has || !cov.commonDates.length;
    $('searchHint').textContent = !has ? 'Laad eerst minstens één bestand.'
      : !cov.commonDates.length ? 'Er zijn geen dagen waarvoor iedereen gegevens heeft.'
        : participants.length + ' deelnemer' + (participants.length === 1 ? '' : 's') + ' · ' + cov.commonDates.length + ' gemeenschappelijke dag' + (cov.commonDates.length === 1 ? '' : 'en');
    if (!has) { searched = false; $('resultsCard').hidden = true; $('heatmapCard').hidden = true; }
    else if (searched) runSearch(false);
  }

  /** Keuzelijst "Minimaal aantal deelnemers": Iedereen (n), n-1 van n, … 1 van n. */
  function buildMinPeople() {
    var sel = $('minPeople'), n = participants.length;
    var prev = sel.dataset.chosen === 'all' || !sel.dataset.chosen ? 'all' : +sel.dataset.chosen;
    ui.clear(sel);
    if (!n) { sel.appendChild(el('option', { text: 'Iedereen' })); sel.disabled = true; return; }
    sel.disabled = n < 2;
    for (var m = n; m >= 1; m--) {
      sel.appendChild(el('option', { value: String(m), text: m === n ? 'Iedereen (' + n + ')' : m + ' van ' + n }));
    }
    sel.value = String(prev === 'all' || prev > n ? n : prev);
    if (!sel.onchange) sel.onchange = function () { sel.dataset.chosen = +sel.value === participants.length ? 'all' : sel.value; };
  }

  function renderParticipants() {
    var list = $('peopleList');
    ui.clear(list);
    var n = participants.length;
    $('peopleCount').textContent = n ? n + (n === 1 ? ' deelnemer geladen' : ' deelnemers geladen') : 'Nog geen deelnemers geladen';
    $('removeAll').hidden = n < 2;
    participants.forEach(function (p) {
      var meta = core.formatPeriod(p.start, p.end) + ' · F ' + core.formatDuration(p.totals.physicalMinutes) + ' · O ' + core.formatDuration(p.totals.onlineMinutes);
      list.appendChild(el('li', { class: 'person' }, [
        el('span', { class: 'ok', attrs: { 'aria-hidden': 'true' } }, icon('check')),
        el('div', {}, [el('div', { class: 'nm', text: p.fullName }), el('div', { class: 'meta', text: meta, title: p.fileName || '' })]),
        el('button', {
          class: 'btn btn-ghost btn-icon btn-sm', type: 'button', attrs: { 'aria-label': p.fullName + ' verwijderen', title: 'Verwijderen' },
          onclick: function () {
            participants = participants.filter(function (x) { return x !== p; });
            onParticipantsChanged();
            ui.toast(p.fullName + ' verwijderd', { icon: 'trash', actionLabel: 'Ongedaan maken', onAction: function () { participants.push(p); onParticipantsChanged(); } });
          }
        }, icon('x'))
      ]));
    });

    var box = $('commonPeriod');
    ui.clear(box);
    if (!n) { box.hidden = true; return; }
    box.hidden = false;
    var cov = matcher.computeCoverage(participants);
    if (!cov.commonDates.length) {
      box.appendChild(el('div', { class: 'alert alert-error', style: { padding: '10px 12px' } }, [icon('alert'),
        el('div', { text: 'De periodes van de deelnemers overlappen niet. Er is geen dag waarvoor iedereen gegevens heeft.' })]));
      return;
    }
    box.appendChild(el('div', {}, [el('strong', { text: 'Gemeenschappelijke periode: ' }),
      core.formatPeriod(cov.commonDates[0], cov.commonDates[cov.commonDates.length - 1]) + ' (' + cov.commonDates.length + ' dagen)']));
    var span = core.diffDays(cov.commonDates[0], cov.commonDates[cov.commonDates.length - 1]) + 1;
    if (span !== cov.commonDates.length) box.appendChild(el('div', { class: 'muted', text: 'Let op: binnen deze periode ontbreken bij iemand dagen.' }));
    if (cov.excluded.length) {
      box.appendChild(el('div', { class: 'muted', style: { 'margin-top': '4px' }, text: cov.excluded.length + ' dag' + (cov.excluded.length === 1 ? '' : 'en') + ' vallen weg omdat niet iedereen gegevens heeft.' }));
    }
  }

  /* =====================================================================
   * Zoeken & resultaten
   * ===================================================================== */
  function runSearch(scroll) {
    if (!participants.length) return;
    var opts = readOptions();
    var notes = $('resultNotes');
    ui.clear(notes);
    if (opts.timeTo - opts.timeFrom < opts.durationMinutes / core.SLOT_MINUTES) {
      notes.appendChild(alertBox('warn', 'Het urenbereik (' + core.formatSlotRange(opts.timeFrom, opts.timeTo) + ') is korter dan de vergaderduur.'));
    }
    if (opts.dateFrom && opts.dateTo && opts.dateFrom > opts.dateTo) {
      notes.appendChild(alertBox('warn', 'De begindatum van de filter ligt na de einddatum.'));
    }
    var res;
    try { res = matcher.analyze(participants, opts); }
    catch (e) { notes.appendChild(alertBox('error', 'Er ging iets mis bij het berekenen: ' + e.message)); return; }
    lastAnalysis = { res: res, opts: opts };

    $('resultsCard').hidden = false;
    renderSummary(res, opts);
    renderResults(matcher.sortResults(res.results, opts.sort), opts);
    renderHeatmap(res, opts);
    if (scroll) ($('heatmapCard').hidden ? $('resultsCard') : $('heatmapCard')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function alertBox(kind, text) {
    return el('div', { class: 'alert alert-' + kind, style: { 'margin-bottom': '12px' } }, [icon(kind === 'info' ? 'info' : 'alert'), el('div', { text: text })]);
  }

  function renderSummary(res, opts) {
    var s = $('resultSummary');
    ui.clear(s);
    var total = res.results.length;
    s.appendChild(el('span', { class: 'badge badge-neutral', text: total + (total === 1 ? ' venster' : ' vensters') + ' · ' + core.formatMeetingDuration(opts.durationMinutes) }));
    ['physical', 'mixed', 'online', 'partial'].forEach(function (t) {
      if (res.counts[t]) s.appendChild(el('span', { class: 'badge ' + TYPE_INFO[t].badge }, [icon(TYPE_INFO[t].icon), res.counts[t] + ' · ' + shortType(t)]));
    });
    var notes = $('resultNotes');
    if (res.hiddenStarts > 0) {
      notes.appendChild(alertBox('info', res.hiddenStarts + ' andere mogelijke starttijd' + (res.hiddenStarts === 1 ? ' valt' : 'en vallen') +
        ' buiten je filters (datum, uren, dagen of type).'));
    }
    if (res.excluded.length) {
      var names = {};
      res.excluded.forEach(function (x) { x.missing.forEach(function (m) { names[m] = true; }); });
      notes.appendChild(alertBox('info', res.excluded.length + ' dag' + (res.excluded.length === 1 ? '' : 'en') +
        ' niet geanalyseerd omdat niet iedereen gegevens heeft (o.a. ' + Object.keys(names).slice(0, 3).join(', ') + ').'));
    }
  }

  function shortType(t) { return t === 'physical' ? 'iedereen fysiek' : t === 'mixed' ? 'fysiek/online' : t === 'online' ? 'iedereen online' : 'niet iedereen'; }

  function renderResults(results, opts) {
    var box = $('results');
    ui.clear(box);
    var full = results.filter(function (r) { return r.type !== 'partial'; });
    var partial = results.filter(function (r) { return r.type === 'partial'; });
    var n = participants.length;
    if (!results.length) {
      box.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'big-ico' }, icon('calendar', 'icon-lg')),
        el('h3', { text: 'Geen gemeenschappelijke momenten gevonden' }),
        el('p', { text: (opts.minParticipants >= n && n > 1)
          ? 'Probeer een kortere vergaderduur, ruimere uren, meer dagen, of kies bij "Minimaal aantal deelnemers" iets lager dan iedereen.'
          : 'Probeer een kortere vergaderduur, ruimere uren of meer dagen en types.' })
      ]));
      return;
    }
    if (partial.length) {
      box.appendChild(el('h3', { class: 'section-head' }, [icon('users'), 'Iedereen kan (' + full.length + ')']));
      if (!full.length) box.appendChild(alertBox('info', 'Er is geen moment waarop iedereen kan (met deze filters). Hieronder staan de momenten waarop minstens ' + opts.minParticipants + ' van de ' + n + ' deelnemers kunnen.'));
    }
    renderList(box, full, opts, 0);
    if (partial.length) {
      box.appendChild(el('h3', { class: 'section-head partial' }, [icon('users'), 'Bijna iedereen: minstens ' + opts.minParticipants + ' van ' + n + ' (' + partial.length + ')']));
      renderList(box, partial, opts, full.length);
    }
  }

  function renderList(box, results, opts, offset) {
    var grouped = opts.sort === 'chrono';
    var currentDate = null, group = null;
    results.forEach(function (r, i) {
      if (grouped && r.date !== currentDate) {
        currentDate = r.date;
        group = el('div', { class: 'date-group' }, el('h3', {}, [icon('calendar'), core.formatDateLong(r.date)]));
        box.appendChild(group);
      }
      var card = resultCard(r, !grouped, offset + i);
      (grouped ? group : box).appendChild(card);
    });
  }

  function resultCard(r, showDate, i) {
    var info = TYPE_INFO[r.type];
    var single = r.startCount === 1;
    var card = el('article', { class: 'result t-' + r.type, style: { 'animation-delay': Math.min(i, 12) * 25 + 'ms' } });
    card.appendChild(el('div', { class: 'stripe', attrs: { 'aria-hidden': 'true' } }));
    var body = el('div', { class: 'result-body' });

    body.appendChild(el('div', {}, [
      el('div', { class: 'result-time' }, [
        el('span', { class: 'lbl', text: showDate ? core.formatDateLong(r.date) : (single ? 'Vergadermoment' : 'Beschikbaarheidsvenster') }),
        core.slotToTime(r.windowStart) + ' – ' + core.slotToTime(r.windowEnd)
      ])
    ]));
    body.appendChild(el('div', {}, el('span', { class: 'badge ' + info.badge }, [icon(info.icon), r.type === 'partial' ? r.availableCount + ' van ' + r.participantCount + ' beschikbaar' : info.label])));

    var meta = el('div', { class: 'result-meta' }, [
      el('span', {}, ['Vergaderduur: ', el('b', { text: core.formatMeetingDuration(r.durationSlots * core.SLOT_MINUTES) })]),
      single
        ? el('span', {}, ['Starttijd: ', el('b', { text: core.slotToTime(r.firstStart) })])
        : el('span', {}, ['Mogelijke starttijden: ', el('b', { text: core.slotToTime(r.firstStart) + ' t/m ' + core.slotToTime(r.lastStart) }), ' (' + r.startCount + ')'])
    ]);
    if (r.type === 'partial') meta.appendChild(el('span', {}, [el('b', { text: r.availableCount + '/' + r.participantCount }), ' beschikbaar: ', el('b', { text: String(r.physicalCount) }), ' fysiek', r.onlineCount ? ' · ' : null, r.onlineCount ? el('b', { text: String(r.onlineCount) }) : null, r.onlineCount ? ' online' : null]));
    else if (r.type === 'mixed') meta.appendChild(el('span', {}, [el('b', { text: String(r.physicalCount) }), ' fysiek · ', el('b', { text: String(r.onlineCount) }), ' alleen online']));
    else meta.appendChild(el('span', {}, [el('b', { text: r.participantCount + '/' + r.participantCount }), r.type === 'physical' ? ' fysiek' : ' online']));
    body.appendChild(meta);

    if (r.type === 'partial') {
      body.appendChild(el('div', { class: 'result-missing' }, [el('strong', { text: 'Niet beschikbaar: ' }), r.missingNames.join(', ')]));
    }
    if ((r.type === 'mixed' || r.type === 'partial') && r.onlineNames.length) {
      body.appendChild(el('div', { class: 'result-online' }, [el('strong', { text: 'Online nodig: ' }), r.onlineNames.join(', ')]));
    }

    var det = el('details', {});
    det.appendChild(el('summary', {}, [icon('chevron'), single ? 'Details' : 'Toon alle ' + r.startCount + ' starttijden']));
    var starts = el('div', { class: 'starts' });
    for (var s = r.firstStart; s <= r.lastStart; s++) starts.appendChild(el('span', { text: core.formatSlotRange(s, s + r.durationSlots) }));
    det.appendChild(starts);
    det.appendChild(el('div', { class: 'btn-row', style: { 'margin-top': '10px' } }, [
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { highlight(r, card, true); } }, [icon('grid'), 'Toon in heatmap'])
    ]));
    body.appendChild(det);

    card.appendChild(body);
    card.addEventListener('mouseenter', function () { highlight(r, card, false); });
    return card;
  }

  function highlight(r, card, scroll) {
    document.querySelectorAll('.result.active').forEach(function (c) { c.classList.remove('active'); });
    document.querySelectorAll('.hm-cell.hl').forEach(function (c) { c.classList.remove('hl'); });
    card.classList.add('active');
    var row = document.querySelector('.hm-track[data-date="' + r.date + '"]');
    if (!row) return;
    row.querySelectorAll('.hm-cell').forEach(function (c) {
      var i = +c.dataset.i;
      if (i >= r.windowStart && i < r.windowEnd) c.classList.add('hl');
    });
    if (scroll) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- Heatmap ---------- */
  function renderHeatmap(res, opts) {
    var card = $('heatmapCard'), box = $('heatmap');
    ui.clear(box);
    var dates = res.consideredDates;
    if (!dates.length) { card.hidden = true; return; }
    card.hidden = false;
    var from = Math.floor(opts.timeFrom / 4) * 4, to = Math.ceil(opts.timeTo / 4) * 4;
    if (to - from < 4) { from = 0; to = N; }
    var cols = to - from;
    var n = participants.length;

    var ruler = el('div', { class: 'r', style: { '--hours': cols / 4 } });
    for (var h = from; h < to; h += 4) ruler.appendChild(el('span', { text: core.slotToTime(h) }));
    box.appendChild(el('div', { class: 'hm-ruler', attrs: { 'aria-hidden': 'true' } }, [el('span'), ruler]));

    matcher.heatmap(participants, dates).forEach(function (day) {
      var track = el('div', { class: 'hm-track', style: { '--cols': cols }, dataset: { date: day.date } });
      for (var i = from; i < to; i++) {
        var p = day.physical[i], o = day.online[i];
        var cls = 'hm-cell' + (i % 4 === 0 && i !== from ? ' h' : '');
        if (day.blocked[i]) cls += ' blk';
        else if (day.nodata[i] === n) cls += ' nd';
        else if (p + o === n) cls += ' all';
        var c = el('div', { class: cls, dataset: { i: i } });
        c.style.setProperty('--p', (p / n * 100) + '%');
        c.style.setProperty('--po', ((p + o) / n * 100) + '%');
        track.appendChild(c);
      }
      track._day = day;
      var wd = core.isoWeekday(day.date);
      box.appendChild(el('div', { class: 'hm-row' }, [
        el('div', { class: 'hm-label' }, [core.formatDateShort(day.date), el('small', { text: wd >= 6 ? 'weekend' : '' })]),
        track
      ]));
    });
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Heatmap van de beschikbaarheid van ' + n + ' deelnemers over ' + dates.length + ' dagen. De resultatenlijst bevat dezelfde informatie als tekst.');

    // Tooltip (muis + touch)
    box.onpointermove = function (e) { if (e.pointerType === 'mouse') cellTip(e.target); };
    box.onpointerdown = function (e) { if (e.pointerType !== 'mouse') cellTip(e.target); };
    box.onpointerleave = function () { tip.hide(); };
  }

  function cellTip(target) {
    var c = target && target.closest ? target.closest('.hm-cell') : null;
    if (!c) { tip.hide(); return; }
    var day = c.parentNode._day, i = +c.dataset.i, n = participants.length;
    var r = c.getBoundingClientRect();
    var sub = day.blocked[i] ? 'Klokwissel: niet beschikbaar'
      : 'Fysiek: ' + day.physical[i] + '/' + n + ' · Online: ' + day.online[i] + '/' + n + ' · Niet beschikbaar: ' + (day.unavailable[i] + day.nodata[i]) + '/' + n;
    tip.show(r.left + r.width / 2, r.top, core.formatDateShort(day.date) + ' · ' + core.formatSlotRange(i, i + 1), sub);
  }

  /* ---------- Kopiëren als tekst ---------- */
  function copyResults() {
    if (!lastAnalysis) return;
    var res = lastAnalysis.res, opts = lastAnalysis.opts;
    var lines = ['LUCID Availability · gemeenschappelijke momenten',
      'Deelnemers (' + participants.length + '): ' + participants.map(function (p) { return p.fullName; }).join(', '),
      'Vergaderduur: ' + core.formatMeetingDuration(opts.durationMinutes) + ' · tijdzone ' + core.TIMEZONE, ''];
    matcher.sortResults(res.results, 'chrono').forEach(function (r) {
      var line = '• ' + core.formatDateLong(r.date) + ', ' + core.slotToTime(r.windowStart) + '–' + core.slotToTime(r.windowEnd) +
        ' · ' + TYPE_INFO[r.type].label +
        (r.startCount > 1 ? ' · starttijden ' + core.slotToTime(r.firstStart) + ' t/m ' + core.slotToTime(r.lastStart) : ' · start ' + core.slotToTime(r.firstStart));
      if (r.type === 'partial') line += ' · ' + r.availableCount + '/' + r.participantCount + ' beschikbaar · niet beschikbaar: ' + r.missingNames.join(', ');
      if ((r.type === 'mixed' || r.type === 'partial') && r.onlineNames.length) line += ' · online nodig: ' + r.onlineNames.join(', ');
      lines.push(line);
    });
    if (!res.results.length) lines.push('Geen gemeenschappelijke momenten gevonden.');
    ui.copyText(lines.join('\n')).then(function () { ui.toast('Overzicht gekopieerd.', { icon: 'copy' }); },
      function () { ui.toast('Kopiëren lukte niet in deze browser.', { icon: 'alert' }); });
  }

  /* ---------- Uitnodigingslink ---------- */
  function bindInvite() {
    $('invCopy').addEventListener('click', function () {
      var s = $('invStart').value, e = $('invEnd').value, err = $('invErr');
      err.textContent = '';
      if (!core.isValidISODate(s) || !core.isValidISODate(e)) { err.textContent = 'Kies een geldige begin- en einddatum.'; return; }
      var n = core.diffDays(s, e) + 1;
      if (n < 1) { err.textContent = 'De einddatum ligt vóór de begindatum.'; return; }
      if (n > core.MAX_PERIOD_DAYS) { err.textContent = 'Maximaal ' + core.MAX_PERIOD_DAYS + ' dagen.'; return; }
      var url = new URL('availability.html', window.location.href);
      url.search = '?start=' + s + '&end=' + e;
      url.hash = '';
      ui.copyText(url.toString()).then(function () { ui.toast('Link gekopieerd: deel hem met je groep.', { icon: 'link' }); },
        function () { window.prompt('Kopieer deze link:', url.toString()); });
    });
  }

  function formatStamp(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 'onbekend';
    return core.nowBrusselsISO(t).slice(0, 16).replace('T', ' ');
  }
})();
