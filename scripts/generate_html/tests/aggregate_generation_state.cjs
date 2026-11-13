const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../templates/dashboard.js'), 'utf8');
const section = (start, end) => {
  const begin = script.indexOf(start), finish = script.indexOf(end, begin);
  assert(begin >= 0 && finish > begin, `Missing source section: ${start}`);
  return script.slice(begin, finish);
};
const identities = new Function(section('  const rawForecastModelKey=', '  const moduleAvailable=') + '\nreturn {rawForecastModelKey,sameForecastModel};')();
const helpers = section('  function reconcileForecastImportState(', '  const boardCache=');
const pairs = [
  ['问界 F2N 2026款汇总', '问界 M9&M9U 2026款', ['问界 M9 2026款', '问界 M9 Ultimate 2026款']],
  ['尊界 X6M 2026款汇总', '尊界 V680&V800 2026款', ['尊界 V680 2026款', '尊界 V800 2026款']],
  ['尚界 SHB 2026款汇总', '尚界 Z7&Z7T 2026款', ['尚界 Z7 2026款', '尚界 Z7T 2026款']],
  ['享界 X4 2026款汇总', '享界 S9&S9T 2026款', ['享界 S9 2026款', '享界 S9T 2026款']],
];
const aliasMatcher = maintained => {
  const aliases = Object.fromEntries(pairs.flatMap(([oldName, newName]) => [oldName, newName].map(name => [identities.rawForecastModelKey(name), maintained === 'old' ? oldName : newName])));
  return (left, right) => identities.sameForecastModel(left, right, aliases);
};
const row = (model, quantity = 10, date = '2026-11-13', metric = 'gross') => ({model, quantity, date, metric, stage: metric === 'small' ? 'small' : 'launch', source: 'original.csv'});
const record = (model, quantity = 10) => ({filename: 'original.csv', rows: [row(model, quantity)]});
function fixture() {
  const imports = new Map(), undo = new Map(), scopes = new Map(), cards = [];
  let persisted, writes = 0;
  function element() { return {dataset: {}, value: '', files: [], hidden: false, disabled: false, textContent: '', setAttribute() {}}; }
  const document = {createElement(tag) {
    if (tag !== 'section') return element();
    const nodes = new Map(), card = element();
    card.querySelector = selector => {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    };
    card.querySelectorAll = selectors => selectors.split(',').map(selector => card.querySelector(selector));
    card.querySelector('[data-forecast-import-mode]').value = 'merge';
    card.querySelector('.forecast-import-actions').append = button => nodes.set('[data-forecast-import-undo]', button);
    return card;
  }};
  const root = {isConnected: true, querySelector(selector) {
    if (selector.startsWith('[data-forecast-import-anchor=')) return {append(card) { cards.push(card); }};
    if (selector === '[data-forecast-input="lock"]') return {value: '80'};
    return null;
  }};
  const persist = () => { writes++; persisted = JSON.parse(JSON.stringify({imports: [...imports], scopes: [...scopes]})); return true; };
  const window = {ForecastImport: {read: async file => file.rows}, confirm: () => true};
  const api = new Function('importedForecastRows', 'importedForecastUndo', 'forecastImportScopes', 'persistForecastState', 'document', 'window', 'fmt', 'esc', 'renderLifecycleLineChart', 'forecastStorageWarning', helpers + '\nreturn {reconcileForecastImportState,selectForecastImportRows,bindForecastImport};')(imports, undo, scopes, persist, document, window, String, String, () => '', '');
  return {...api, imports, undo, scopes, root, cards, snapshot: () => persisted, writes: () => writes};
}

for (const [oldName, newName, members] of pairs) {
  for (const maintained of ['old', 'new']) {
    const same = aliasMatcher(maintained);
    assert(same(oldName, newName), 'Old and new aggregate labels must share identity');
    for (const member of members) assert(!same(newName, member), 'Aggregate must not match an individual member');
    assert(!same(newName, newName.replace('2026', '2027')), 'Different model years must remain separate');
    const target = maintained === 'old' ? oldName : newName, previousName = maintained === 'old' ? newName : oldName;
    const f = fixture(), previous = record(previousName);
    f.imports.set(previousName, previous); f.imports.set(members[0], record(members[0], 99));
    f.undo.set(previousName, previous); f.scopes.set(previousName, {small: 'all', launch: 'future'});
    assert(f.reconcileForecastImportState(target, same));
    assert.strictEqual(f.imports.get(target), previous, 'Renamed import preserves original rows and provenance');
    assert.strictEqual(f.undo.get(target), previous);
    assert.deepEqual(f.scopes.get(target), {small: 'all', launch: 'future'});
    assert(!f.imports.has(previousName)); assert(f.imports.has(members[0]));
    assert(!f.reconcileForecastImportState(target, same), 'Migration must be idempotent');

    // Current display label wins as a whole saved dataset, regardless of insertion order.
    const current = record(target, 20);
    f.imports.clear(); f.imports.set(previousName, previous); f.imports.set(target, current);
    f.undo.set(previousName, previous); f.undo.set(target, current);
    f.scopes.set(previousName, {launch: 'future'}); f.scopes.set(target, {launch: 'all'});
    f.reconcileForecastImportState(target, same);
    assert.strictEqual(f.imports.get(target), current); assert.equal(f.imports.get(target).rows.length, 1);
    assert.strictEqual(f.undo.get(target), current); assert.deepEqual(f.scopes.get(target), {launch: 'all'});
    f.imports.set(previousName, previous); f.imports.set(target, {filename: '', rows: []});
    f.reconcileForecastImportState(target, same);
    assert.equal(f.imports.get(target).rows.length, 0, 'An empty current dataset must not resurrect old aliases');

    const alternate = row(previousName, 10), exact = row(target, 20), nextDay = row(previousName, 7, '2026-11-14');
    for (const order of [[alternate, exact], [exact, alternate]]) {
      assert.throws(() => f.selectForecastImportRows(order, target, same), /同指标重复/);
    }
    const selected = f.selectForecastImportRows([exact, nextDay, row(target, 3, '2026-11-13', 'small'), row(members[0], 100), row(target.replace('2026', '2027'), 200)], target, same);
    assert.equal(selected.length, 3);
    assert.equal(selected.reduce((sum, item) => sum + item.quantity, 0), 30);
    assert.throws(() => f.selectForecastImportRows([exact, {...exact}], target, same), /同指标重复/);
    assert.throws(() => f.selectForecastImportRows([alternate, {...alternate}], target, same), /同指标重复/);
  }
}


// Load real saved-state payloads through the production loader before board aliases exist.
const subjectFunctions = section('  function forecastSubjectId(', '  function captureForecastDraft(');
const draftLookup = section('  function sameForecastReferenceValue(', '  function restoreForecastDraft(');
const persistence = section('  function persistForecastState(){', '  loadForecastState();');
const oldSubjectId = name => 'generation_' + require('node:crypto').createHash('sha1').update(name.replace(/\s/g, '')).digest('hex').slice(0, 10);
const subjectData = {forecast_subject_aliases: {}, subjects: []};
for (const [oldName, newName] of pairs) {
  const canonical = oldSubjectId(oldName);
  subjectData.subjects.push({id: canonical, name: newName});
  for (const name of [oldName.replace(/汇总$/, ''), newName, newName + '汇总', newName + '总计']) {
    const previous = oldSubjectId(name);
    if (previous !== canonical) subjectData.forecast_subject_aliases[previous] = canonical;
  }
}
function savedStateFixture(drafts) {
  return new Function('DATA', 'payload', 'sameForecastModel', `
    const forecastDrafts=new Map(),importedForecastRows=new Map(),forecastImportScopes=new Map();
    const forecastStorageKey='fixture',FORECAST_APP=true,forecastStages=[{id:'small'},{id:'launch'},{id:'steady'}];
    let forecastStorageWarning='',saved=JSON.stringify(payload);
    const location={protocol:'https:',pathname:'/forecast'},localStorage={getItem:()=>saved,setItem:(key,value)=>{saved=value}};
    ${subjectFunctions}${draftLookup}${persistence}
    loadForecastState();
    return {drafts:forecastDrafts,forecastRequestedSubject,forecastDraftForSubject,forecastDraftSubjectKey,forecastSubjectId,
      stored:()=>JSON.parse(saved),warning:()=>forecastStorageWarning,
      clear:key=>{forecastDrafts.delete(key);persistForecastState();forecastDrafts.clear();loadForecastState();}};
  `)(subjectData, {version: 1, drafts, imports: [], scopes: []}, aliasMatcher('new'));
}
const draft = label => ({label, controls: [{key: 'input', value: '0', checked: null}]});
for (const [oldName, newName, members] of pairs) {
  const current = oldSubjectId(oldName), previousIds = [oldSubjectId(oldName.replace(/汇总$/, '')), oldSubjectId(newName)], unknown = oldSubjectId(members[0]);
  for (const previous of previousIds) {
    for (const entries of [[[previous, draft('old')], [current, draft('current')]], [[current, draft('current')], [previous, draft('old')]]]) {
      const f = savedStateFixture([...entries, [unknown, draft('member')]]);
      assert.equal(f.warning(), '');
      assert.equal(f.drafts.get(current).label, 'current'); assert(!f.drafts.has(previous));
      assert.equal(f.forecastRequestedSubject(previous).id, current);
      assert.equal(f.forecastRequestedSubject(newName).id, current);
      assert.equal(f.drafts.get(unknown).label, 'member');
      assert(!f.stored().drafts.some(([key]) => key === previous));
      f.clear(current); assert(!f.drafts.has(current), 'Cleared canonical subject must not revive a legacy ID');
    }
    const oldEvent = identities.rawForecastModelKey(oldName), newEvent = identities.rawForecastModelKey(newName);
    const f = savedStateFixture([[previous + '|' + oldEvent, draft('campaign')], [current + '|other-event|2026-11-20', draft('other')]]);
    assert(f.drafts.has(current + '|' + oldEvent), 'Initial subject migration must preserve the complete suffix');
    assert.equal(f.forecastDraftSubjectKey(previous + '|event|with|separators'), current + '|event|with|separators');
    assert.equal(f.forecastDraftForSubject(current + '|' + newEvent).label, 'campaign');
    assert(!f.drafts.has(current + '|' + oldEvent));
    assert(f.drafts.has(current + '|other-event|2026-11-20'));
    f.clear(current + '|' + newEvent); assert(!f.forecastDraftForSubject(current + '|' + newEvent));
    const currentWins = savedStateFixture([[previous + '|' + oldEvent, draft('old-event')], [current + '|' + newEvent, draft('current-event')]]);
    assert.equal(currentWins.forecastDraftForSubject(current + '|' + newEvent).label, 'current-event');
  }
}
const unknownState = savedStateFixture([['unmapped-subject|event', draft('untouched')]]);
assert.equal(unknownState.forecastSubjectId('toString'), 'toString', 'Only explicit subject alias metadata may migrate IDs');
assert(unknownState.drafts.has('unmapped-subject|event'));

// Reference drafts store model labels (launch) or model identity inside event IDs.
const referenceFunctions = section('  function sameForecastReferenceValue(', '  const importedForecastRows');
const controlKey = section('  const forecastDraftControlKey=', '  function captureForecastDraft(');
for (const [oldName, newName, members] of pairs) {
  const controls = [], drafts = new Map(), root = {dataset: {}, _forecastSubjectId: 'stable-subject', querySelectorAll: () => controls, querySelector: () => null};
  const api = new Function('document', 'forecastDrafts', 'state', 'DATA', 'forecastStorageWarning', 'sameForecastModel', 'forecastDraftSelector', controlKey + referenceFunctions + '\nreturn {sameForecastReferenceValue,restoreForecastDraft,key:forecastDraftControlKey};')({querySelector: () => root}, drafts, {subject: 'stable-subject'}, {}, '', aliasMatcher('new'), '');
  const event = (name, date = '2026-11-01', sheet = 'Sheet1') => `small|${identities.rawForecastModelKey(name)}|${identities.rawForecastModelKey(name)}|${date}|${sheet}`;
  assert(api.sameForecastReferenceValue(oldName, newName));
  assert(api.sameForecastReferenceValue(event(oldName), event(newName)));
  assert(!api.sameForecastReferenceValue(event(oldName), event(newName, '2026-11-02')));
  assert(!api.sameForecastReferenceValue(event(oldName), event(newName, '2026-11-01', 'Sheet2')));
  assert(!api.sameForecastReferenceValue(oldName, members[0]));
  const select = {tagName: 'SELECT', type: 'select-one', value: '', disabled: false, attributes: [{name: 'data-forecast-ref', value: 'daily'}], options: [{value: newName}], closest: () => null, matches: () => true};
  const checkbox = {tagName: 'INPUT', type: 'checkbox', value: newName, checked: false, disabled: false, attributes: [{name: 'data-forecast-chart-ref', value: 'daily'}, {name: 'type', value: 'checkbox'}, {name: 'value', value: newName}], closest: () => null};
  const oldCheckbox = {...checkbox, value: oldName, attributes: checkbox.attributes.map(item => item.name === 'value' ? {...item, value: oldName} : item)};
  controls.push(select, checkbox);
  drafts.set('stable-subject', {controls: [{key: api.key(select), value: oldName, checked: null}, {key: api.key(oldCheckbox), value: oldName, checked: true}]});
  api.restoreForecastDraft();
  assert.equal(select.value, newName); assert.equal(checkbox.value, newName); assert.equal(checkbox.checked, true);
  assert(root._forecastTouched.has(api.key(checkbox))); assert(!root._forecastTouched.has(api.key(oldCheckbox)));
  select.value = ''; select.options[0].disabled = true; checkbox.checked = false; checkbox.disabled = true;
  api.restoreForecastDraft();
  assert.equal(select.value, ''); assert.equal(checkbox.checked, false, 'Current unavailable references must remain excluded');
  select.options = [{value: newName}, {value: oldName + ' '}]; checkbox.disabled = false;
  api.restoreForecastDraft();
  assert.equal(select.value, '', 'Ambiguous alias options must not be guessed');
  select.options = [{value: event(newName)}]; select.value = '';
  drafts.set('stable-subject', {controls: [{key: api.key(select), value: event(oldName), checked: null}]});
  api.restoreForecastDraft(); assert.equal(select.value, event(newName));
}

(async () => {
  // Exercise the actual binding: restoration, upload, clear/undo, and a later label change.
  const [oldName, newName, members] = pairs[0], f = fixture(), same = aliasMatcher('new');
  let name = newName;
  f.imports.set(oldName, record(oldName)); f.imports.set(members[0], record(members[0], 99));
  f.scopes.set(oldName, {launch: 'all'});
  const context = {sameModel: same, targetState: () => ({name, launchDate: '2026-11-01', steadyStartDate: '2026-12-01'}), stageInfo: () => ({end: '2026-11-30'}), todayIso: () => '2026-11-13', actualForTarget: () => ({}), actualRows: () => []};
  f.bindForecastImport(f.root, context);
  assert.equal(f.writes(), 1, 'Initial restoration must persist the renamed keys once');
  assert(f.snapshot().imports.some(([key]) => key === newName));
  assert(f.snapshot().scopes.some(([key]) => key === newName));
  const card = f.cards.find(item => item.dataset.forecastImport === 'launch');
  assert.equal(card.querySelector('.forecast-import-manager').open, false);
  const input = card.querySelector('[data-forecast-import-file]');
  const beforeDuplicate = f.imports.get(newName);
  input.files = [{name: 'updated.csv', rows: [{model: oldName, date: '2026-11-13', gross: 11}, {model: newName, date: '2026-11-13', gross: 22}, {model: newName, date: '2026-11-14', small: 3, gross: 7}, {model: members[0], date: '2026-11-13', gross: 999}]}];
  await input.onchange();
  assert.equal(card.querySelector('[data-forecast-import-status]').dataset.state, 'error');
  assert.match(card.querySelector('[data-forecast-import-status]').textContent, /同指标重复/);
  assert.strictEqual(f.imports.get(newName), beforeDuplicate, 'Conflicting alias rows must preserve the saved dataset');
  input.files = [{name: 'updated.csv', rows: [{model: oldName, date: '2026-11-13', gross: 22}, {model: newName, date: '2026-11-14', small: 3, gross: 7}, {model: members[0], date: '2026-11-13', gross: 999}]}];
  await input.onchange();
  assert.equal(card.querySelector('[data-forecast-import-status]').dataset.state, 'success');
  assert.equal(f.imports.get(newName).rows.length, 3);
  assert.equal(f.imports.get(newName).rows.find(item => item.date === '2026-11-13').quantity, 22);
  assert(f.imports.get(newName).rows.every(item => item.source === 'updated.csv'));
  card.querySelector('[data-forecast-import-clear]').onclick();
  assert(!f.imports.has(newName) && !f.imports.has(oldName));
  assert(f.imports.has(members[0]), 'Clearing an aggregate must preserve its individual members');
  f.root._renderImportedForecast();
  assert(!f.imports.has(newName), 'Re-rendering after clear must not revive the old label');
  card.querySelector('[data-forecast-import-undo]').onclick();
  assert.equal(f.imports.get(newName).rows.length, 3);
  name = oldName; f.root._renderImportedForecast();
  assert(f.imports.has(oldName) && !f.imports.has(newName));
  assert.equal(f.imports.get(oldName).rows.length, 3, 'Switching maintained label back must preserve imported values');
  console.log('PASS aggregate identities, subject/URL migration, import/reference drafts, duplicate rejection, clear/undo, and reverse rename');
})().catch(error => { console.error(error); process.exitCode = 1; });
