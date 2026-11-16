// The detection engine against herdr's own evaluator tests
// (src/detect/manifest/tests.rs, herdr ee5bfb5041): the same rules, the
// same screens, the same answers — the port must behave as the original,
// or herdr's rules would mean something else here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileManifest, detectionScreen, evaluate, regionText, rustRegex, type AgentManifest, type ManifestRule } from './engine.ts';

const codex = (rules: ManifestRule[]) => compileManifest({ id: 'codex', rules } as AgentManifest);
const run = (m: ReturnType<typeof codex>, screen: string, title = '', progress = '') => evaluate(m, { screen, title, progress });

test('no rule matches: a known agent is idle (herdr fallback)', () => {
  const m = codex([{ id: 'x', state: 'working', contains: ['never'] }]);
  const r = run(m, 'anything');
  assert.equal(r.state, 'idle');
  assert.equal(r.fallback, 'default_known_agent_idle_fallback');
  assert.equal(r.rule, undefined);
});

test('gates, priority and line_regex (rule_semantics_apply_gates_priority_and_line_regex)', () => {
  const m = codex([
    { id: 'low_contains', state: 'idle', priority: 1, contains: ['match'] },
    { id: 'high_nested_gates', state: 'working', priority: 10, contains: ['match'], all: [{ any: [{ regex: ['w[io]n'] }, { contains: ['fallback'] }] }], not: [{ contains: ['blocked'] }] },
    { id: 'line_regex', state: 'blocked', priority: 20, line_regex: ['^exact line$'] },
  ]);
  assert.equal(run(m, 'match win').rule?.id, 'high_nested_gates');
  assert.equal(run(m, 'match win').state, 'working');
  assert.equal(run(m, 'match win blocked').rule?.id, 'low_contains');
  assert.equal(run(m, 'before\nexact line\nafter').state, 'blocked');
});

test('contains ignores case; on equal priority the earlier rule wins', () => {
  const m = codex([
    { id: 'first', state: 'idle', priority: 5, contains: ['ESC TO'] },
    { id: 'second', state: 'working', priority: 5, contains: ['esc to'] },
  ]);
  assert.equal(run(m, 'press Esc To interrupt').rule?.id, 'first');
});

test('end-anchored footer gates allow only an auxiliary tail (end_anchored_footer_gates_allow_only_auxiliary_tail)', () => {
  const m = codex([
    {
      id: 'live_controls',
      state: 'blocked',
      region: 'whole_recent',
      regex: ['(?i)(?:^|\\n)controls:\\s+(?:confirm-marker|select-marker\\s+navigate-marker)\\s+cancel-marker[ \\t]*\\n---[^\\n]*(?:\\npanel: \\d+(?:\\nrow: [^\\n]+)+(?:\\n… \\+\\d+ pending)?)?(?:\\n[ \\t]*)*\\z'],
    },
  ]);
  const footer = 'controls: select-marker navigate-marker cancel-marker';
  for (const tail of ['--- name', '--- name\npanel: 5\nrow: active\nrow: pending\nrow: pending\nrow: pending\nrow: done\n', '--- name\npanel: 5\nrow: active\nrow: done\n… +3 pending']) {
    const live = `old output\n${footer}\n${tail}`;
    assert.equal(run(m, live).state, 'blocked', tail);
    for (const later of ['new output', 'prompt:', '--- next\nprompt:', 'prompt: continue…', 'working: processing…', '…ordinary output', 'finished…', '… +2 arbitrary words']) {
      assert.equal(run(m, `${live}\n${later}`).state, 'idle', `${tail} + ${later}`);
    }
  }
  for (const tail of ['--- name\n… +2 pending', '--- name\nrow: active', '--- name\npanel: 5', '--- name\npanel: 5\nrow: active\n  working: processing…', '--- name\npanel: 5\nrow: active\n  prompt: continue…']) {
    assert.equal(run(m, `${footer}\n${tail}`).state, 'idle', tail);
  }
  for (const controls of ['controls: confirm-marker cancel-marker', 'controls: select-marker\nnavigate-marker cancel-marker', 'controls:\nselect-marker\nnavigate-marker\ncancel-marker']) {
    assert.equal(run(m, `${controls}\n--- name`).state, 'blocked', controls);
  }
  for (const controls of ['controls: select-marker cancel-marker', 'controls: navigate-marker cancel-marker', 'controls: confirm-marker', 'controls: select-marker unrelated navigate-marker cancel-marker', 'controls: select-marker\nprompt: navigate-marker cancel-marker']) {
    assert.equal(run(m, `confirm-marker navigate-marker\n${controls}\n--- name`).state, 'idle', controls);
  }
});

test('paired alternatives need a complete gate in the bottom lines (paired_alternatives_require_complete_gates_at_bottom_buffer)', () => {
  const m = codex([
    {
      id: 'paired',
      state: 'blocked',
      region: 'bottom_non_empty_lines(3)',
      visible_blocker: true,
      any: [
        { all: [{ contains: ['alpha heading'] }, { regex: ['alpha\\s+control\\s*\\z'] }] },
        { all: [{ contains: ['beta heading'] }, { regex: ['beta\\s+control\\s*\\z'] }] },
      ],
    },
  ]);
  for (const text of ['alpha heading\nalpha control', 'beta heading\nbeta\ncontrol']) {
    const r = run(m, text);
    assert.equal(r.state, 'blocked', text);
    assert.equal(r.visibleBlocker, true);
  }
  for (const text of ['alpha heading\nbeta control', 'beta heading\nalpha control', 'beta control', 'beta heading', 'beta heading\nbeta control\nnewer content', 'beta heading\nfiller one\nfiller two\nbeta control']) {
    const r = run(m, text);
    assert.equal(r.rule, undefined, text);
    assert.equal(r.visibleBlocker, false, text);
  }
});

test('title and progress are their own inputs and share the priority order (osc_regions_use_separate_inputs_and_share_rule_priority)', () => {
  const m = codex([
    { id: 'screen', state: 'idle', priority: 10, region: 'whole_recent', visible_idle: true, contains: ['screen-marker'] },
    { id: 'title', state: 'working', priority: 20, region: 'osc_title', visible_working: true, regex: ['^title-marker$'] },
    { id: 'progress', state: 'blocked', priority: 30, region: 'osc_progress', visible_blocker: true, regex: ['^progress-marker$'] },
  ]);
  const cases: Array<[string, string, string, string, string]> = [
    ['screen-marker', '', '', 'idle', 'screen'],
    ['screen-marker', 'title-marker', '', 'working', 'title'],
    ['screen-marker', 'title-marker', 'progress-marker', 'blocked', 'progress'],
    ['screen-marker title-marker progress-marker', '', '', 'idle', 'screen'],
  ];
  for (const [screen, title, progress, state, rule] of cases) {
    const r = run(m, screen, title, progress);
    assert.equal(r.state, state);
    assert.equal(r.rule?.id, rule);
    assert.equal(r.visibleIdle, state === 'idle');
    assert.equal(r.visibleWorking, state === 'working');
    assert.equal(r.visibleBlocker, state === 'blocked');
  }
  assert.equal(run(m, '', 'progress-marker', 'title-marker').rule, undefined);
});

test('a skip rule says unknown and keep the previous state (skip_rule_suppresses_state_update_without_visible_state_evidence)', () => {
  const m = codex([
    { id: 'activity', state: 'working', priority: 10, visible_working: true, contains: ['activity-marker'] },
    { id: 'overlay', state: 'unknown', priority: 20, skip_state_update: true, contains: ['overlay-marker'] },
  ]);
  const r = run(m, 'activity-marker overlay-marker');
  assert.equal(r.state, 'unknown');
  assert.equal(r.skipStateUpdate, true);
  assert.equal(r.visibleWorking, false);
});

test('regions cut the screen as herdr does (screen_regions_extract_structure_without_classifying_agent_state)', () => {
  const cases: Array<[string, string, string]> = [
    ['old\n\nnew\n', 'bottom_lines(2)', '\nnew\n'],
    ['before\n› input\nafter\n', 'after_last_prompt_marker', 'after\n'],
    ['before\n› input\nafter\n', 'before_current_prompt_marker', 'before\n'],
    ['before\n› input\nafter\n', 'whole_recent_without_current_prompt_marker', ''],
    ['no marker\n', 'whole_recent_without_current_prompt_marker', 'no marker\n'],
    ['• old\n■ latest\n› input\n', 'current_prompt_block_marker', '■ latest'],
    ['• old\n■ latest\n› input\n', 'after_current_prompt_block_marker', '■ latest\n› input\n'],
    ['› old\n• new\n', 'current_prompt_block_marker', ''],
    ['above\n\n───\nbody\n───\nfooter\n', 'above_prompt_box', 'above\n\n'],
    ['above\n\n───\nbody\n───\nfooter\n', 'last_non_empty_above_prompt_box', 'above'],
    ['above\n───\nbody\n───\nfooter\n', 'prompt_box_body', 'body\n'],
    ['above\n───\nbody\n───\nfooter\n', 'after_last_horizontal_rule', 'footer\n'],
    // bottom_non_empty_lines_uses_bottom_occurrence_for_repeated_text
    ['marker\nold\n\nmiddle\nmarker\nnew\n', 'bottom_non_empty_lines(2)', 'marker\nnew\n'],
    // top_non_empty_lines_uses_top_occurrence_for_repeated_text
    ['\nmarker\nold\n\nmiddle\nmarker\nnew\n', 'top_non_empty_lines(2)', '\nmarker\nold\n'],
  ];
  for (const [screen, spec, expected] of cases) {
    assert.equal(regionText({ screen }, spec), expected, `region=${spec}`);
  }
});

test('top_non_empty_lines takes only a canonical positive count', () => {
  const ok = (region: string) => compileManifest({ id: 'codex', rules: [{ id: 'r', state: 'idle', region, contains: ['x'] }] });
  ok('top_non_empty_lines(1)');
  ok('top_non_empty_lines(65535)');
  for (const count of ['0', '01', '+1', '999999999999999999999999']) {
    assert.throws(() => ok(`top_non_empty_lines(${count})`), /unknown region/, count);
  }
});

test('Rust regex syntax is translated: flags, \\x{…}, \\A, \\z, \\p{…}', () => {
  assert.equal(rustRegex('(?i)esc TO').test('ESC to'), true);
  assert.equal(rustRegex('(?m)^b$').test('a\nb\nc'), true);
  assert.equal(rustRegex('(?s)a.b').test('a\nb'), true);
  assert.equal(rustRegex('^[\\x{2800}-\\x{28FF}] Working$').test('⠏ Working'), true);
  assert.equal(rustRegex('end\\z').test('the end'), true);
  assert.equal(rustRegex('end\\z').test('the end\n'), false);
  assert.equal(rustRegex('\\A> You').test('> You are'), true);
  assert.equal(rustRegex('\\A> You').test('x\n> You'), false);
  assert.equal(rustRegex('\\p{Alphabetic}+ing\\b').test('Thinking about'), true);
  assert.throws(() => rustRegex('a(?i)b'), /inside the pattern/);
  assert.throws(() => rustRegex('(?x)a b'), /not supported/);
});

test('a manifest is checked before use', () => {
  assert.throws(() => compileManifest({ id: 'codex', rules: [{ id: 'r', state: 'idle', region: 'nowhere', contains: ['x'] }] }), /unknown region/);
  assert.throws(() => compileManifest({ id: 'codex', rules: [{ id: 'r', state: 'idle', regex: ['('] }] }), /regex\[0\]/);
  assert.throws(() => compileManifest({ id: 'codex', rules: [{ id: 'r', state: 'idle' }] }), /no matcher/);
  assert.throws(() => compileManifest({ id: 'codex', rules: [{ id: 'r', state: 'happy' as never, contains: ['x'] }] }), /unknown state/);
  assert.throws(() => compileManifest({ id: 'codex', rules: [{ id: 'r', contains: ['x'] }, { id: 'r', contains: ['y'] }] }), /duplicate/);
  assert.throws(() => compileManifest({ id: 'codex', min_engine_version: 9, rules: [] }), /needs engine 9/);
});

test('the detection screen is the visible rows without trailing blank rows', () => {
  assert.equal(detectionScreen('old 1\nold 2\nrow a\nrow b\n\n\n', 4), 'row a\nrow b');
  assert.equal(detectionScreen('a\nb\n', 10), 'a\nb');
});
