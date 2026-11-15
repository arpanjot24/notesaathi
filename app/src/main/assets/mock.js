/* Only used when the page is opened in a desktop browser for design checks.
   Inside the app the real `Android` object exists and this file does nothing. */
(function () {
  if (window.Android) return;
  var settings = { provider: 'gemini', geminiKey: 'demo' };
  var count = 0;
  var sample = {
    title: 'Photosynthesis',
    language: 'Hindi',
    sections: [
      { heading: 'What it is', points: [
        '[[d:Photosynthesis = the process by which green plants make their own food using sunlight]] (prakash sanshleshan).',
        'It happens mainly in the [[k:leaves]], inside tiny green parts called [[k:chloroplasts]].',
        'The green colour comes from [[k:chlorophyll]], which traps sunlight.'
      ] },
      { heading: 'What the plant needs', points: [
        '[[n:Carbon dioxide]] from the air, taken in through small holes called stomata.',
        'Water from the soil, pulled up by the roots.',
        'Sunlight as the source of energy. One word here looked like [[u:xylem]].'
      ] },
      { heading: 'What it makes', points: [
        '[[d:6CO2 + 6H2O + light → C6H12O6 + 6O2]]',
        'Glucose is stored as [[k:starch]]; oxygen is released into the air.'
      ] }
    ],
    summary: [
      'Plants make food in their leaves using sunlight, water and carbon dioxide.',
      'Chlorophyll traps the light; glucose and oxygen come out.'
    ],
    _usage: { in: 1900, out: 950 }
  };
  var story = {
    title: "Birbal's green kitchen",
    story: 'Akbar asked who the best cook in the kingdom was. Birbal pointed at a neem tree. "This cook takes air from the courtyard, water from the well and fire from the sun, and cooks in a green pot. It keeps the sweet for itself and gives the fresh air to all of us for free."',
    links: ['Air from the courtyard = carbon dioxide', 'Water from the well = water from roots', 'Fire from the sun = sunlight', 'Green pot = chlorophyll', 'Sweet = glucose, fresh air = oxygen']
  };
  window.Android = {
    version: function () { return '1.0.0 (preview)'; },
    getSettings: function () { return JSON.stringify(Object.assign({ defaultGeminiModel: 'gemini-flash-latest', defaultClaudeModel: 'claude-opus-5-5', defaultDeepseekModel: 'deepseek-flash', defaultOpenrouterModel: 'google/gemini-2.5-flash-lite' }, settings)); },
    saveSettings: function (j) { settings = JSON.parse(j); },
    takePhoto: function () { count++; window.onNative('pages', { count: count }); },
    pickImages: function () { count += 2; window.onNative('pages', { count: count }); },
    pickPdf: function () { count += 3; window.onNative('pages', { count: count }); },
    pageCount: function () { return count; },
    loadData: function (n) { return localStorage.getItem('mock.' + n) || ''; },
    saveData: function (n, j) { localStorage.setItem('mock.' + n, j); return true; },
    keepAwake: function () {},
    log: function (m) { console.log('[log] ' + m); },
    fetchPrices: function (p, m) { setTimeout(function () { window.onNative('prices', { model: m, in: 0.7499999, out: 3.75, inr: 94.262076, cny: 6.689676 }); }, 300); },
    deepseekBalance: function (tag) { var a = tag === 'start' ? 5.0 : 4.9871; setTimeout(function () { window.onNative('balance', { tag: tag, ok: true, amount: a, currency: 'USD' }); }, 100); },
    makeTopics: function (id, digestJson) {
      var n = JSON.parse(digestJson).length;
      var half = Math.max(1, Math.ceil(n / 2));
      var topics = [{ from: 1, to: half, title: 'Photosynthesis', mnemonic: story }];
      if (n > half) topics.push({ from: half + 1, to: n, title: 'Respiration', mnemonic: story });
      setTimeout(function () { window.onNative('topicsDone', { id: id, ok: true, data: { topics: topics, _usage: { in: 800, out: 600 } } }); }, 900);
    },
    testKey: function (j) { var p = JSON.parse(j).provider; setTimeout(function () { window.onNative('keyTest', { provider: p, ok: true, message: 'Key works (preview).' }); }, 300); },
    thumb: function () { return ''; },
    removePage: function () { count = Math.max(0, count - 1); },
    clearPages: function () { count = 0; },
    transcribe: function (i) { setTimeout(function () { window.onNative('pageDone', { index: i, ok: true, data: JSON.parse(JSON.stringify(sample)) }); }, 700); },
    print: function () { window.print(); },
    checkUpdate: function () {},
    installUpdate: function () {}
  };
})();
