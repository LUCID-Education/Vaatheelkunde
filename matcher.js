/*!
 * LUCID Availability – matcher.js
 * ------------------------------------------------------------------
 * Het rekenhart van de coördinatorpagina. Puur JavaScript, geen DOM,
 * zodat het algoritme automatisch getest kan worden (tests/run-tests.js).
 *
 * ALGORITME
 * 1. Enkel dagen waarvoor ÁLLE deelnemers gegevens hebben, komen in aanmerking.
 * 2. Voor elke mogelijke starttijd s (in stappen van 15 min) en vergaderduur k blokken
 *    wordt per deelnemer bepaald of die in het VOLLEDIGE interval [s, s+k):
 *      - overal 'physical' is   → fysiek
 *      - overal 'online' is     → online
 *      - overal physical/online → beschikbaar (maar dus "online nodig" als niet overal fysiek)
 * 3. Elke starttijd krijgt precies één categorie:
 *      'physical' – iedereen is het hele interval fysiek beschikbaar
 *      'online'   – iedereen is het hele interval alleen online beschikbaar
 *      'mixed'    – iedereen is beschikbaar, maar minstens één persoon moet (deels) online
 *    Is iemand ergens 'unavailable' (of valt het in een klokwissel-uur), dan vervalt de starttijd.
 * 4. Opeenvolgende starttijden met dezelfde categorie én dezelfde groep "online nodig"
 *    worden samengevoegd tot één beschikbaarheidsvenster, zodat er geen lange lijst
 *    met overlappende intervallen ontstaat.
 */
(function (root, factory) {
  'use strict';
  var core = (root && root.LUCID && root.LUCID.core) ||
    (typeof require === 'function' ? require('./core.js') : null);
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.LUCID = root.LUCID || {}; root.LUCID.matcher = api; }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  var N_SLOTS = core.SLOTS_PER_DAY;
  var S = core.STATUS;
  var TYPE_ORDER = { physical: 0, mixed: 1, online: 2, partial: 3 };

  /** Datums waarvoor elke deelnemer gegevens heeft + datums die daardoor wegvallen. */
  function computeCoverage(participants) {
    var union = {}, coverCount = {};
    participants.forEach(function (p) {
      p.covered.forEach(function (d) { union[d] = true; coverCount[d] = (coverCount[d] || 0) + 1; });
    });
    var all = Object.keys(union).sort();
    var common = [], excluded = [];
    all.forEach(function (d) {
      if (coverCount[d] === participants.length) common.push(d);
      else {
        excluded.push({
          date: d,
          missing: participants.filter(function (p) { return p.covered.indexOf(d) < 0; })
            .map(function (p) { return p.fullName; })
        });
      }
    });
    return { allDates: all, commonDates: common, excluded: excluded };
  }

  /** Prefix-sommen per deelnemer voor één dag (geblokkeerde DST-blokken = niet beschikbaar). */
  function prefixFor(arr, blocked) {
    var phys = new Uint16Array(N_SLOTS + 1), onl = new Uint16Array(N_SLOTS + 1), avail = new Uint16Array(N_SLOTS + 1);
    for (var i = 0; i < N_SLOTS; i++) {
      var v = blocked[i] ? S.UNAVAILABLE : arr[i];
      phys[i + 1] = phys[i] + (v === S.PHYSICAL ? 1 : 0);
      onl[i + 1] = onl[i] + (v === S.ONLINE ? 1 : 0);
      avail[i + 1] = avail[i] + (v !== S.UNAVAILABLE ? 1 : 0);
    }
    return { phys: phys, onl: onl, avail: avail };
  }

  /**
   * Classificeer elke starttijd van één dag en voeg samen tot vensters.
   * @param {string} date
   * @param {Array} participants
   * @param {number} k        vergaderduur in blokken
   * @param {number} lo       vroegste starttijd (slotindex)
   * @param {number} hi       laatste eindtijd (slotindex, exclusief)
   * @param {number} [minCount] minimaal aantal beschikbare deelnemers (standaard: iedereen)
   *
   * Types: 'physical' | 'mixed' | 'online' (iedereen kan) en
   *        'partial' (minstens minCount, maar niet iedereen kan).
   */
  function findForDate(date, participants, k, lo, hi, minCount) {
    var blocked = core.blockedSlots(date);
    var pref = participants.map(function (p) { return prefixFor(p.slots[date], blocked); });
    var n = participants.length;
    var need = Math.max(1, Math.min(n, minCount || n));
    var groups = [];
    var current = null;

    for (var s = lo; s + k <= hi; s++) {
      var e = s + k;
      var allPhys = true, allOnline = true;
      var needOnline = [], missing = [];
      for (var i = 0; i < n; i++) {
        var P = pref[i];
        var physSum = P.phys[e] - P.phys[s];
        var onlSum = P.onl[e] - P.onl[s];
        var availSum = P.avail[e] - P.avail[s];
        if (availSum < k) {                      // niet het volledige interval beschikbaar
          missing.push(i);
          if (n - missing.length < need) break;  // kan het minimum niet meer halen
          continue;
        }
        if (physSum < k) { allPhys = false; needOnline.push(i); }
        if (onlSum < k) allOnline = false;
      }
      var available = n - missing.length;
      var type = null;
      if (available === n) type = allPhys ? 'physical' : (allOnline ? 'online' : 'mixed');
      else if (available >= need) type = 'partial';

      var key = type ? type + '|' + (type === 'mixed' || type === 'partial' ? needOnline.join(',') : '') + '|' + missing.join(',') : null;
      if (current && key === current.key && s === current.lastStart + 1) {
        current.lastStart = s;
      } else {
        if (current) groups.push(current);
        current = key ? { key: key, type: type, firstStart: s, lastStart: s, needOnline: needOnline.slice(), missing: missing.slice() } : null;
      }
    }
    if (current) groups.push(current);

    return groups.map(function (g) {
      var names = function (pred) { return participants.filter(pred).map(function (p) { return p.fullName; }).sort(collate); };
      var isMissing = function (p, i) { return g.missing.indexOf(i) >= 0; };
      var isOnline = function (p, i) { return g.type === 'online' || g.needOnline.indexOf(i) >= 0; };
      var physicalNames = names(function (p, i) { return !isMissing(p, i) && !isOnline(p, i); });
      var onlineNames = names(function (p, i) { return !isMissing(p, i) && isOnline(p, i); });
      var missingNames = names(isMissing);
      return {
        date: date,
        weekday: core.isoWeekday(date),
        type: g.type,
        firstStart: g.firstStart,
        lastStart: g.lastStart,
        windowStart: g.firstStart,
        windowEnd: g.lastStart + k,
        durationSlots: k,
        startCount: g.lastStart - g.firstStart + 1,
        participantCount: n,
        availableCount: n - g.missing.length,
        physicalCount: physicalNames.length,
        onlineCount: onlineNames.length,
        physicalNames: physicalNames,
        onlineNames: onlineNames,
        missingNames: missingNames
      };
    });
  }

  function collate(a, b) { return a.localeCompare(b, 'nl', { sensitivity: 'base' }); }

  /**
   * Hoofdfunctie.
   * @param {Array} participants  gevalideerde deelnemers (core.validateDocument(...).data)
   * @param {object} opts {
   *   durationMinutes: 60,
   *   dateFrom, dateTo: 'YYYY-MM-DD' (optioneel),
   *   timeFrom, timeTo: slotindex 0…96 (vergadering moet volledig binnen dit bereik vallen),
   *   weekdays: [1..7] (1 = maandag),
   *   types: { physical: true, mixed: true, online: true },
   *   minParticipants: 7   (optioneel; standaard iedereen)
   * }
   */
  function analyze(participants, opts) {
    opts = opts || {};
    var out = { results: [], commonDates: [], consideredDates: [], excluded: [], hiddenStarts: 0, totalStarts: 0, counts: { physical: 0, mixed: 0, online: 0, partial: 0 } };
    if (!participants || !participants.length) return out;

    var k = Math.round((opts.durationMinutes || 60) / core.SLOT_MINUTES);
    if (k < 1 || k > N_SLOTS) throw new Error('Ongeldige vergaderduur.');
    var timeFrom = clampInt(opts.timeFrom, 0, N_SLOTS, 0);
    var timeTo = clampInt(opts.timeTo, 0, N_SLOTS, N_SLOTS);
    var weekdays = opts.weekdays || [1, 2, 3, 4, 5, 6, 7];
    var types = opts.types || { physical: true, mixed: true, online: true };
    var minCount = clampInt(opts.minParticipants, 1, participants.length, participants.length);
    out.minParticipants = minCount;

    var cov = computeCoverage(participants);
    out.commonDates = cov.commonDates;
    out.excluded = cov.excluded;

    var filteredStarts = 0, allStarts = 0;
    cov.commonDates.forEach(function (date) {
      // Ongefilterd (voor de melding "x starttijden vallen buiten je filters")
      findForDate(date, participants, k, 0, N_SLOTS, minCount).forEach(function (r) { allStarts += r.startCount; });

      if (opts.dateFrom && date < opts.dateFrom) return;
      if (opts.dateTo && date > opts.dateTo) return;
      if (weekdays.indexOf(core.isoWeekday(date)) < 0) return;
      out.consideredDates.push(date);

      findForDate(date, participants, k, timeFrom, timeTo, minCount).forEach(function (r) {
        if (r.type !== 'partial' && !types[r.type]) return;
        filteredStarts += r.startCount;
        out.counts[r.type]++;
        out.results.push(r);
      });
    });
    out.totalStarts = allStarts;
    out.hiddenStarts = Math.max(0, allStarts - filteredStarts);
    return out;
  }

  function clampInt(v, min, max, dflt) {
    if (typeof v !== 'number' || isNaN(v)) return dflt;
    return Math.max(min, Math.min(max, Math.round(v)));
  }

  /** Sorteer resultaten. mode: 'chrono' | 'type' | 'length' */
  function sortResults(results, mode) {
    var arr = results.slice();
    function chrono(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.windowStart - b.windowStart || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]; }
    if (mode === 'available') arr.sort(function (a, b) { return b.availableCount - a.availableCount || chrono(a, b); });
    else if (mode === 'type') arr.sort(function (a, b) { return TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || chrono(a, b); });
    else if (mode === 'length') arr.sort(function (a, b) { return (b.windowEnd - b.windowStart) - (a.windowEnd - a.windowStart) || chrono(a, b); });
    else arr.sort(chrono);
    return arr;
  }

  /**
   * Heatmap-gegevens: per dag en per blok het aantal deelnemers per status.
   * @returns {Array<{date, physical:Uint8Array, online:Uint8Array, unavailable:Uint8Array, nodata:Uint8Array, blocked:Uint8Array}>}
   */
  function heatmap(participants, dates) {
    return dates.map(function (date) {
      var blocked = core.blockedSlots(date);
      var phys = new Uint8Array(N_SLOTS), onl = new Uint8Array(N_SLOTS), un = new Uint8Array(N_SLOTS), nd = new Uint8Array(N_SLOTS);
      participants.forEach(function (p) {
        var arr = p.slots[date];
        for (var i = 0; i < N_SLOTS; i++) {
          if (!arr) { nd[i]++; continue; }
          var v = blocked[i] ? S.UNAVAILABLE : arr[i];
          if (v === S.PHYSICAL) phys[i]++; else if (v === S.ONLINE) onl[i]++; else un[i]++;
        }
      });
      return { date: date, physical: phys, online: onl, unavailable: un, nodata: nd, blocked: blocked };
    });
  }

  return {
    analyze: analyze,
    findForDate: findForDate,
    computeCoverage: computeCoverage,
    sortResults: sortResults,
    heatmap: heatmap,
    TYPE_ORDER: TYPE_ORDER
  };
});
