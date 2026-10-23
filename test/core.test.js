'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../hostlens.user.js');

const date = (y, m, d) => new Date(y, m - 1, d);
const TODAY = date(2026, 10, 5);

test('parseMoney understands the usual number formats', () => {
  assert.deepEqual(core.parseMoney('7.35 €'), { cents: 735, currency: '€' });
  assert.deepEqual(core.parseMoney(' 1.25 € '), { cents: 125, currency: '€' });
  assert.deepEqual(core.parseMoney('1 234,50 ₽'), { cents: 123450, currency: '₽' });
  assert.deepEqual(core.parseMoney('1,234.50 $'), { cents: 123450, currency: '$' });
  assert.deepEqual(core.parseMoney('1.234,50 EUR'), { cents: 123450, currency: '€' });
  assert.deepEqual(core.parseMoney('−3.10 €'), { cents: -310, currency: '€' });
  assert.equal(core.parseMoney('—'), null);
  assert.equal(core.parseMoney(''), null);
});

test('parsePeriod reads Russian billing periods', () => {
  assert.deepEqual(core.parsePeriod('Месяц'), { months: 1, days: 0 });
  assert.deepEqual(core.parsePeriod('3 месяца'), { months: 3, days: 0 });
  assert.deepEqual(core.parsePeriod('Год'), { months: 12, days: 0 });
  assert.deepEqual(core.parsePeriod('Квартал'), { months: 3, days: 0 });
  assert.deepEqual(core.parsePeriod('Неделя'), { months: 0, days: 7 });
  assert.deepEqual(core.parsePeriod('Сутки'), { months: 0, days: 1 });
  assert.equal(core.parsePeriod('что-то странное'), null);
  assert.equal(core.parsePeriod(''), null);
});

test('parseCost splits price and period', () => {
  const cost = core.parseCost('7.35 € / Месяц');
  assert.equal(cost.cents, 735);
  assert.equal(cost.currency, '€');
  assert.deepEqual(cost.period, { months: 1, days: 0 });
  assert.equal(cost.periodGuessed, false);

  assert.equal(core.parseCost('7.35 € / непонятно').periodGuessed, true);
  assert.equal(core.parseCost('7.35 €').periodGuessed, false);
  assert.equal(core.parseCost('нет цены'), null);
});

test('addMonths clamps to the last day of a shorter month', () => {
  assert.deepEqual(core.addMonths(date(2026, 1, 31), 1), date(2026, 2, 28));
  assert.deepEqual(core.addMonths(date(2028, 1, 31), 1), date(2028, 2, 29));
  assert.deepEqual(core.addMonths(date(2026, 10, 5), 1), date(2026, 11, 5));
  assert.deepEqual(core.addMonths(date(2026, 11, 30), 3), date(2027, 2, 28));
});

test('parseDate accepts ISO and dotted dates', () => {
  assert.deepEqual(core.parseDate('2026-10-20'), date(2026, 10, 20));
  assert.deepEqual(core.parseDate('20.10.2026'), date(2026, 10, 20));
  assert.equal(core.parseDate(''), null);
});

const row = (name, expire, cost, status = 'Активен') => ({ name, note: '', status, expire, cost });

test('analyze: only services expiring before the horizon need a payment', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('b', '2026-10-22', '8.50 € / Месяц'),
    row('c', '2026-12-01', '10.00 € / Месяц'),
  ];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 100, currency: '€' } });

  assert.deepEqual(result.monthly, { '€': 2250 });
  assert.deepEqual(result.due, { '€': 1250 });
  assert.deepEqual(result.topUp, { '€': 1150 });
  assert.equal(result.dueCount, 2);
  assert.deepEqual(result.nextExpiry, date(2026, 10, 20));
  assert.deepEqual(result.horizon, date(2026, 11, 5));
});

test('analyze: a longer horizon needs several renewals per service', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('b', '2026-12-01', '10.00 € / Месяц'),
  ];
  // horizon = 2027-01-05: a renews Nov 20, Dec 20, Jan 20 (3x); b renews Jan 1, Feb 1 (2x)
  const result = core.analyze(rows, { today: TODAY, months: 3, balance: null });
  assert.deepEqual(result.items.map((i) => i.renewals), [3, 2]);
  assert.deepEqual(result.due, { '€': 1200 + 2000 });
});

test('analyze: an expired service restarts from today', () => {
  const rows = [row('a', '2026-09-01', '5.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.equal(result.items[0].renewals, 1);
  assert.deepEqual(result.due, { '€': 500 });
});

test('analyze: balance that covers everything leaves nothing to top up', () => {
  const rows = [row('a', '2026-10-20', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 1000, currency: '€' } });
  assert.deepEqual(result.topUp, { '€': -600 });
});

test('analyze: balance in another currency is not subtracted', () => {
  const rows = [row('a', '2026-10-20', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 1000, currency: '₽' } });
  assert.deepEqual(result.topUp, { '€': 400 });
});

test('analyze: yearly prices are normalised to a month, renewal uses the full period', () => {
  const rows = [row('a', '2026-10-20', '120.00 € / Год')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.deepEqual(result.monthly, { '€': 1000 });
  assert.deepEqual(result.due, { '€': 12000 });
});

test('analyze: deleted services and unparsable prices are skipped and reported', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('gone', '2026-10-20', '9.00 € / Месяц', 'Удалён'),
    row('free', '2026-10-20', 'бесплатно'),
  ];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.equal(result.items.length, 1);
  assert.equal(result.issues.noPrice, 1);
});

test('analyze: a service without an expiry date counts in the total but never needs a payment', () => {
  const rows = [row('a', '', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.deepEqual(result.monthly, { '€': 400 });
  assert.deepEqual(result.due, {});
});

test('formatting helpers', () => {
  assert.equal(core.formatMoney(8765, '€'), '87.65 €');
  assert.equal(core.formatMoney(123456789, '€'), '1 234 567.89 €');
  assert.equal(core.formatMoney(-125, '€'), '−1.25 €');
  assert.equal(core.formatMoneyMap({}, '€'), '0.00 €');
  assert.equal(core.formatDate(date(2026, 11, 5)), '05.11.2026');
  assert.equal(core.plural(1, 'услуга', 'услуги', 'услуг'), 'услуга');
  assert.equal(core.plural(7, 'услуга', 'услуги', 'услуг'), 'услуг');
  assert.equal(core.plural(22, 'услуга', 'услуги', 'услуг'), 'услуги');
  assert.equal(core.plural(11, 'услуга', 'услуги', 'услуг'), 'услуг');
  assert.equal(core.daysUntil(date(2026, 10, 20), TODAY), 'через 15 дн.');
  assert.equal(core.daysUntil(TODAY, TODAY), 'сегодня');
  assert.equal(core.daysUntil(date(2026, 10, 3), TODAY), 'просрочено на 2 дн.');
});

test('parsePeriod reads WHMCS cycles', () => {
  assert.deepEqual(core.parsePeriod('Monthly'), { months: 1, days: 0 });
  assert.deepEqual(core.parsePeriod('Quarterly'), { months: 3, days: 0 });
  assert.deepEqual(core.parsePeriod('Semi-Annually'), { months: 6, days: 0 });
  assert.deepEqual(core.parsePeriod('Annually'), { months: 12, days: 0 });
  assert.deepEqual(core.parsePeriod('Biennially'), { months: 24, days: 0 });
  assert.deepEqual(core.parsePeriod('One Time'), { months: 0, days: 0, once: true });
  assert.deepEqual(core.parsePeriod('Free Account'), { months: 0, days: 0, once: true });
});

test('WHMCS style prices: decimal comma and a currency code', () => {
  assert.deepEqual(core.parseMoney('6,25 EUR'), { cents: 625, currency: '€' });
  const cost = core.parseCost('12,00 EUR / Quarterly');
  assert.equal(cost.cents, 1200);
  assert.deepEqual(cost.period, { months: 3, days: 0 });
});

test('analyze: quarterly service is normalised to a month and renewed as a whole quarter', () => {
  const rows = [row('q', '2026-10-20', '12,00 EUR / Quarterly')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.deepEqual(result.monthly, { '€': 400 });
  assert.deepEqual(result.due, { '€': 1200 });
});

test('analyze: terminated and cancelled services are ignored, one-time ones cost nothing monthly', () => {
  const rows = [
    row('a', '2026-10-20', '4,00 EUR / Monthly', 'Active'),
    row('b', '2025-09-10', '6,25 EUR / Monthly', 'Terminated'),
    row('c', '2025-09-10', '6,25 EUR / Monthly', 'Cancelled'),
    row('d', '', '9,00 EUR / One Time', 'Active'),
  ];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.monthly, { '€': 400 });
  assert.deepEqual(result.due, { '€': 400 });
});

test('extractIps finds IPv4 and IPv6 and ignores prices and versions', () => {
  assert.deepEqual(core.extractIps('Primary IP 203.0.113.7'), ['203.0.113.7']);
  assert.deepEqual(core.extractIps('203.0.113.7, 198.51.100.2/32; 2001:db8::1'), ['203.0.113.7', '198.51.100.2/32', '2001:db8::1']);
  assert.deepEqual(core.extractIps('v4.0.4 6,25 EUR 999.1.1.1'), []);
});

test('parseTrafficValue turns used / total into a percentage', () => {
  const t = core.parseTrafficValue('2048MB / 1048576MB');
  assert.equal(t.percentText, '0%');
  assert.equal(t.usedText, '2048 MB');
  assert.equal(t.totalText, '1048576 MB');
  assert.equal(core.parseTrafficValue('5 GB / 10 GB').percentText, '50%');
  assert.equal(core.parseTrafficValue('512 MB / 1 GB').percentText, '50%');
  assert.equal(core.parseTrafficValue('no data'), null);
});

test('subnetHosts: every address except network, broadcast and gateway', () => {
  const { hosts, prefix } = core.subnetHosts('203.0.113.8/29', '203.0.113.9');
  assert.equal(prefix, 29);
  assert.deepEqual(hosts, ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14']);
});

test('subnetHosts: gateway is excluded wherever it is, and defaults to network + 1', () => {
  assert.deepEqual(core.subnetHosts('203.0.113.8/29', '203.0.113.14').hosts,
    ['203.0.113.9', '203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13']);
  assert.deepEqual(core.subnetHosts('203.0.113.8/29').hosts,
    ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14']);
});

test('subnetHosts: other sizes, host bits in the address and bad input', () => {
  assert.equal(core.subnetHosts('203.0.113.0/28', '203.0.113.1').hosts.length, 13);
  assert.equal(core.subnetHosts('203.0.113.4/30', '203.0.113.5').hosts.length, 1);
  assert.deepEqual(core.subnetHosts('203.0.113.11/29', '203.0.113.9').hosts[0], '203.0.113.10'); // 11 is inside 8/29
  assert.deepEqual(core.subnetHosts('203.0.113.255/24', '203.0.113.1').hosts.length, 253);
  assert.equal(core.subnetHosts('2001:db8::/64'), null);
  assert.equal(core.subnetHosts('203.0.113.8'), null);
  assert.equal(core.subnetHosts('203.0.113.8/8'), null); // too big to list
  assert.equal(core.subnetHosts('999.0.113.8/29'), null);
});

test('formatNetplan indents list items with exactly eight spaces and has no trailing newline', () => {
  const text = core.formatNetplan(core.subnetHosts('203.0.113.8/29', '203.0.113.9'));
  assert.equal(text, [10, 11, 12, 13, 14].map((n) => `        - 203.0.113.${n}/29`).join('\n'));
  assert.ok(!text.endsWith('\n'));
});

test('formatNetplan: the quoted Ubuntu style uses six spaces and quotes every address', () => {
  const subnet = core.subnetHosts('203.0.113.8/29', '203.0.113.9');
  const lines = core.formatNetplan(subnet, { indent: 6, quote: true }).split('\n');
  assert.equal(lines[0], '      - "203.0.113.10/29"');
  assert.equal(lines.length, 5);
  assert.equal(core.formatNetplan(subnet).split('\n')[0], '        - 203.0.113.10/29');
});
