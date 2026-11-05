import type { Catalog } from './index.ts';

export const INTERFACES: Catalog = {
  // ── Web tools ──────────────────────────────────────────────────────
  web: {
    label: 'Web search and fetch',
    help: 'What agents may use on the web: a search key, and which addresses in your own network they may read.',
    level: 'basic',
    docs: 'tools.md#time-and-web',
  },
  'web.brave': {
    label: 'Brave Search',
    help: 'The account for web search; without it agents can still fetch pages but cannot search.',
    level: 'basic',
    docs: 'tools.md#time-and-web',
  },
  'web.brave.apiKey': {
    label: 'Brave Search API key',
    help: 'Your Brave Search API key, which gives agents the web search tool.',
    level: 'basic',
    sensitive: true,
    docs: 'tools.md#time-and-web',
  },
  'web.fetchAllowPrivate': {
    label: 'Private addresses agents may read',
    help: 'Addresses inside your own network that agents may fetch pages from; all others there are refused.',
    more: 'List a host name, *.suffix for a whole domain, an IP address or an IPv4 range, for example wiki.home.lan or 10.0.0.0/24. Only add what agents really need.',
    level: 'advanced',
    placeholder: 'wiki.home.lan',
    docs: 'security.md#web-and-browser',
  },

  // ── Mobile app ─────────────────────────────────────────────────────
  mobile: {
    label: 'Mobile app',
    help: 'What the chat on the phone shows by default.',
    level: 'basic',
    docs: 'mobile.md#settings',
  },
  'mobile.show': {
    label: 'Shown in the phone chat',
    help: 'Which extra rows the phone chat starts with.',
    level: 'basic',
    docs: 'mobile.md#settings',
  },
  'mobile.show.tools': {
    label: 'Show tool activity',
    help: 'Where the tools switch starts for a chat agent\'s session on the phone; your choice per session on the phone wins.',
    more: 'Builders always start with tool activity shown.',
    level: 'basic',
    docs: 'mobile.md#tool-activity',
  },
  'mobile.show.memory': {
    label: 'Show recalled notes',
    help: 'Where the memory switch starts on the phone: a line above each reply naming the notes the agent was given. Your choice per session on the phone wins.',
    level: 'basic',
    docs: 'mobile.md#recalled-notes',
  },

  // ── Terminal client ────────────────────────────────────────────────
  tui: {
    label: 'Terminal client',
    help: 'What the terminal chat client shows when it starts; the /show and /verbose commands change it while it runs.',
    level: 'basic',
    docs: 'display.md#the-two-switches',
  },
  'tui.show': {
    label: 'Lines shown',
    help: 'Which kinds of lines appear in the terminal chat at all.',
    level: 'basic',
    docs: 'display.md#the-two-switches',
  },
  'tui.show.memory': {
    label: 'Show memory lines',
    help: 'Shows a line when notes are recalled for the agent; hiding it changes the display only, the notes are still recalled.',
    level: 'basic',
    docs: 'display.md#the-two-switches',
  },
  'tui.show.tools': {
    label: 'Show tool calls',
    help: 'Shows tool calls, their results and engine lines; hiding them changes the display only, the tools still run.',
    level: 'basic',
    docs: 'display.md#the-two-switches',
  },
  'tui.verbose': {
    label: 'Details shown',
    help: 'How much detail the shown lines carry in the terminal chat.',
    level: 'advanced',
    docs: 'display.md#the-two-switches',
  },
  'tui.verbose.tools': {
    label: 'Full tool input and output',
    help: 'Adds the full input and output below each tool call and result.',
    level: 'advanced',
    docs: 'display.md#the-two-switches',
  },
  'tui.verbose.memory': {
    label: 'Full recalled text',
    help: 'Adds the full recalled text below each memory line, as the model received it.',
    level: 'advanced',
    docs: 'display.md#the-two-switches',
  },
  'tui.verbose.system': {
    label: 'System prompt flag',
    help: 'Start value of the system flag that /verbose lists; it does not print the system prompt at start.',
    more: 'Use /verbose system on in the client to print the prompt once.',
    level: 'advanced',
    docs: 'display.md#settings',
  },
  'tui.verbose.thinking': {
    label: 'Show thinking text',
    help: 'Shows the model\'s thinking text above each reply, for engines that provide it.',
    level: 'advanced',
    docs: 'display.md#thinking-text',
  },

  // ── Live streams to clients ────────────────────────────────────────
  sse: {
    label: 'Live connections to clients',
    help: 'How the server keeps the live streams to open chat windows healthy and drops clients that stopped answering.',
    more: 'Only change these when clients often lose their connection or a stuck client holds up a chat.',
    level: 'advanced',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.publishTimeoutMs': {
    label: 'Delivery time per client',
    help: 'How long one event may take to reach one client; a client over it is dropped so it cannot hold up the chat.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.publishParallel': {
    label: 'Send to all clients at once',
    help: 'Sends each event to all open clients at the same time, so one slow client never delays the others.',
    more: 'Off sends to one client after the other; only for an integration that needs a strict order.',
    level: 'advanced',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.heartbeatMs': {
    label: 'Heartbeat interval',
    help: 'How often the server sends a heartbeat on every live stream, so clients notice a lost connection.',
    level: 'advanced',
    unit: 'ms',
    docs: 'api.md#get-chatstream',
  },
  'sse.deadAfterMs': {
    label: 'Drop a silent client after',
    help: 'A client whose heartbeat could not be delivered for this long is disconnected.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.h2PingIntervalMs': {
    label: 'Connection check interval',
    help: 'How often each client connection is pinged over HTTPS, so a tab that vanished is noticed within about a minute.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.h2PingTimeoutMs': {
    label: 'Connection check timeout',
    help: 'A client that does not answer the HTTPS ping within this time is disconnected.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
  'sse.keepAliveDelayMs': {
    label: 'Network keepalive delay',
    help: 'After how long without traffic the operating system starts checking whether a connection is still alive.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#stuck-engines-and-stuck-clients',
  },
};
