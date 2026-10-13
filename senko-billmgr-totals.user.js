// ==UserScript==
// @name         Senko BILLmanager: итоги по услугам
// @namespace    https://github.com/dykomenko/senko-billmgr-totals
// @version      1.2.0
// @description  Под списком услуг в кабинете BILLmanager (my.senko.digital, my.waicore.com, my.h2.nexus) показывает суммарную стоимость в месяц и сумму, которую нужно доплатить, чтобы всё работало ещё месяц.
// @author       dykomenko
// @license      MIT
// @match        https://my.senko.digital/billmgr*
// @match        https://my.waicore.com/billmgr*
// @match        https://my.h2.nexus/billmgr*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  https://github.com/dykomenko/senko-billmgr-totals
// @supportURL   https://github.com/dykomenko/senko-billmgr-totals/issues
// @updateURL    https://raw.githubusercontent.com/dykomenko/senko-billmgr-totals/main/senko-billmgr-totals.user.js
// @downloadURL  https://raw.githubusercontent.com/dykomenko/senko-billmgr-totals/main/senko-billmgr-totals.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Parsing and calculation. Pure functions, no DOM access.
   * ------------------------------------------------------------------ */

  const SPACES = /[\s  ]+/g;
  const DAY_MS = 864e5;
  const MAX_RENEWALS = 10000;

  const CURRENCY_ALIASES = [
    [/€|eur/i, '€'],
    [/\$|usd/i, '$'],
    [/£|gbp/i, '£'],
    [/₽|руб|rub|р\./i, '₽'],
    [/₴|грн|uah/i, '₴'],
    [/₸|тенге|kzt/i, '₸'],
  ];

  function normalizeCurrency(raw) {
    const text = String(raw || '').replace(/[\s  ,:/]+/g, ' ').trim();
    for (const [re, sign] of CURRENCY_ALIASES) if (re.test(text)) return sign;
    return text.length <= 5 ? text : '';
  }

  // "1 234.50", "1,234.50", "1.234,50" and "4,5" all come out right.
  function toNumber(raw) {
    let s = raw.replace(SPACES, '').replace('−', '-');
    const dot = s.lastIndexOf('.');
    const comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      const decimal = dot > comma ? '.' : ',';
      const group = decimal === '.' ? ',' : '.';
      s = s.split(group).join('').replace(decimal, '.');
    } else {
      s = s.replace(',', '.');
    }
    return parseFloat(s);
  }

  const MONEY_RE = /[-−]?\d(?:[\d\s  .,]*\d)?/;

  function parseMoney(text) {
    const source = String(text || '');
    const match = MONEY_RE.exec(source);
    if (!match) return null;
    const value = toNumber(match[0]);
    if (!Number.isFinite(value)) return null;
    const rest = source.slice(0, match.index) + ' ' + source.slice(match.index + match[0].length);
    return { cents: Math.round(value * 100), currency: normalizeCurrency(rest) };
  }

  const PERIOD_UNITS = [
    [/^час/, { days: 1 / 24 }],
    [/^(сут|ден|дн)/, { days: 1 }],
    [/^недел/, { days: 7 }],
    [/^мес/, { months: 1 }],
    [/^квартал/, { months: 3 }],
    [/^полугод/, { months: 6 }],
    [/^(год|лет)/, { months: 12 }],
  ];

  const MONTH = { months: 1, days: 0 };

  // "Месяц", "3 месяца", "Год", "Неделя" ...
  function parsePeriod(text) {
    const match = /^\s*(\d+)?\s*(\S+)/.exec(String(text || '').toLowerCase());
    if (!match) return null;
    const n = match[1] ? parseInt(match[1], 10) : 1;
    for (const [re, unit] of PERIOD_UNITS) {
      if (re.test(match[2])) return { months: (unit.months || 0) * n, days: (unit.days || 0) * n };
    }
    return null;
  }

  const periodInMonths = (p) => p.months + p.days / 30;

  // "5.00 € / Месяц" -> price of one billing period.
  function parseCost(text) {
    const [price, periodText = ''] = String(text || '').split('/');
    const money = parseMoney(price);
    if (!money) return null;
    const period = parsePeriod(periodText);
    return {
      cents: money.cents,
      currency: money.currency,
      period: period || MONTH,
      periodGuessed: !period && periodText.trim() !== '',
    };
  }

  function parseDate(text) {
    const s = String(text || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return null;
  }

  // Jan 31 + 1 month = Feb 28/29, not Mar 3.
  function addMonths(date, n) {
    const result = new Date(date.getFullYear(), date.getMonth() + n, 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(date.getDate(), lastDay));
    return result;
  }

  function addPeriod(date, period) {
    const d = period.months ? addMonths(date, period.months) : date;
    return period.days ? new Date(d.getTime() + period.days * DAY_MS) : d;
  }

  // How many paid periods are needed for a service to stay alive until `horizon`.
  // A service that has already expired starts over from today, not from its old date.
  function renewalsNeeded(expire, period, today, horizon) {
    let end = expire < today ? today : expire;
    let n = 0;
    while (end < horizon && n < MAX_RENEWALS) {
      end = addPeriod(end, period);
      n++;
    }
    return n;
  }

  const sumInto = (map, key, value) => {
    map[key] = (map[key] || 0) + value;
  };

  const roundMap = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Math.round(v)]));

  /**
   * rows: [{ name, note, status, expire, cost }] with raw cell texts.
   * Returns totals per currency (in cents) and a per-service breakdown.
   */
  function analyze(rows, { today, months, balance }) {
    const horizon = addMonths(today, months);
    const monthly = {};
    const due = {};
    const items = [];
    const issues = { noPrice: 0, guessedPeriod: 0 };
    let nextExpiry = null;

    for (const row of rows) {
      if (/удал/i.test(row.status || '')) continue;
      const cost = parseCost(row.cost);
      if (!cost) {
        issues.noPrice++;
        continue;
      }
      if (cost.periodGuessed) issues.guessedPeriod++;

      const expire = parseDate(row.expire);
      const renewals = expire ? renewalsNeeded(expire, cost.period, today, horizon) : 0;
      const dueCents = renewals * cost.cents;

      sumInto(monthly, cost.currency, cost.cents / periodInMonths(cost.period));
      if (dueCents) sumInto(due, cost.currency, dueCents);
      if (expire && (!nextExpiry || expire < nextExpiry)) nextExpiry = expire;
      items.push({ name: row.name, note: row.note, expire, cost, renewals, dueCents });
    }

    const topUp = {};
    for (const [currency, cents] of Object.entries(due)) {
      const covers = balance && (!balance.currency || !currency || balance.currency === currency);
      topUp[currency] = cents - (covers ? balance.cents : 0);
    }

    return {
      horizon,
      months,
      items,
      monthly: roundMap(monthly),
      due,
      topUp,
      dueCount: items.filter((i) => i.renewals > 0).length,
      nextExpiry,
      issues,
    };
  }

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;

  function formatMoney(cents, currency) {
    const sign = cents < 0 ? '−' : '';
    const number = (Math.abs(cents) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .replace(/,/g, ' ');
    return `${sign}${number}${currency ? ' ' + currency : ''}`;
  }

  function formatMoneyMap(map, fallbackCurrency) {
    const parts = Object.entries(map).map(([currency, cents]) => formatMoney(cents, currency));
    return parts.length ? parts.join(' + ') : formatMoney(0, fallbackCurrency);
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    return b === 1 ? one : many;
  }

  function daysUntil(date, today) {
    const n = Math.round((date - today) / DAY_MS);
    if (n === 0) return 'сегодня';
    return n > 0 ? `через ${n} дн.` : `просрочено на ${-n} дн.`;
  }

  if (typeof module !== 'undefined' && typeof document === 'undefined') {
    // Loaded by the unit tests in Node, not by Tampermonkey.
    module.exports = {
      parseMoney, parsePeriod, parseCost, parseDate, addMonths, renewalsNeeded, analyze,
      formatMoney, formatMoneyMap, formatDate, plural, daysUntil,
    };
    return;
  }

  /* ------------------------------------------------------------------ *
   * Page integration
   * ------------------------------------------------------------------ */

  if (window.__senkoBillmgrTotals) return;
  window.__senkoBillmgrTotals = true;

  const PANEL_CLASS = 'sbt-panel';
  const HORIZONS = [1, 2, 3, 6, 12];

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('sbt:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('sbt:' + key, JSON.stringify(value));
      } catch (e) { /* storage is optional */ }
    },
  };

  const savedMonths = store.get('months', 1);
  const state = {
    months: HORIZONS.includes(savedMonths) ? savedMonths : 1,
    open: store.get('open', false) === true,
  };

  const STYLE = `
    .${PANEL_CLASS} {
      flex: none; box-sizing: border-box; padding: 10px 16px 12px;
      border-top: 1px solid var(--isp-border-default, #d9d9d9);
      background: var(--isp-background-additional, #fff);
      color: var(--isp-text-main, #1b1b1b); font-size: 13px; line-height: 1.4;
    }
    .${PANEL_CLASS} .sbt-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 36px; }
    .${PANEL_CLASS} .sbt-label { color: var(--isp-text-additional, #707070); font-size: 12px; white-space: nowrap; }
    .${PANEL_CLASS} .sbt-value { font-size: 20px; font-weight: 600; line-height: 1.3; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .${PANEL_CLASS} .sbt-sub { color: var(--isp-text-additional, #707070); font-size: 12px; }
    .${PANEL_CLASS} .sbt-value--ok { color: var(--isp-text-success, #1a8f43); }
    .${PANEL_CLASS} .sbt-value--due { color: var(--isp-text-danger, #c62828); }
    .${PANEL_CLASS} .sbt-spacer { flex: 1 1 auto; }
    .${PANEL_CLASS} .sbt-toggle {
      align-self: center; padding: 2px 0; border: 0; background: none; cursor: pointer;
      color: var(--isp-text-interactive, #7335ff); font: inherit;
    }
    .${PANEL_CLASS} .sbt-select {
      margin-left: 4px; padding: 0 2px; font: inherit; color: inherit; cursor: pointer;
      background: transparent; border: 1px solid var(--isp-border-default, #d9d9d9); border-radius: 4px;
    }
    .${PANEL_CLASS} .sbt-warn { margin-top: 8px; color: var(--isp-text-warning, #b26a00); font-size: 12px; }
    .${PANEL_CLASS} .sbt-details { display: none; margin-top: 10px; max-height: 40vh; overflow: auto; }
    .${PANEL_CLASS}.sbt-open .sbt-details { display: block; }
    .${PANEL_CLASS} .sbt-table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    .${PANEL_CLASS} .sbt-table th, .${PANEL_CLASS} .sbt-table td {
      padding: 4px 16px 4px 0; text-align: left; white-space: nowrap;
      border-bottom: 1px solid var(--isp-border-default, #e4e4e4);
    }
    .${PANEL_CLASS} .sbt-table th { color: var(--isp-text-additional, #707070); font-weight: 400; font-size: 12px; }
    .${PANEL_CLASS} .sbt-table .sbt-num { text-align: right; }
    .${PANEL_CLASS} .sbt-table .sbt-muted { color: var(--isp-text-additional, #707070); }
    .${PANEL_CLASS} .sbt-table tfoot td { font-weight: 600; border-bottom: 0; }
  `;

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  const textOf = (node) => (node ? node.textContent.replace(SPACES, ' ').trim() : '');
  const cellOf = (tr, name) => textOf(tr.querySelector(`td[data-table-column-name="${name}"]`));

  // Lists of services have both a cost and an expiry column (VDS, dedicated, domains...).
  // The script relies on BILLmanager's `data-table-column-name` attributes (cost, expiredate,
  // item_status, domain, pricelist) and on <isp-table>/<isp-balance>; if the panel disappears
  // after a BILLmanager update, these selectors are the first thing to check.
  function readRows(table) {
    if (!table.querySelector('td[data-table-column-name="expiredate"]')) return [];
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (!tr.querySelector('td[data-table-column-name="cost"]')) continue;
      rows.push({
        name: cellOf(tr, 'domain') || cellOf(tr, 'name') || cellOf(tr, 'id'),
        note: cellOf(tr, 'pricelist'),
        status: cellOf(tr, 'item_status'),
        expire: cellOf(tr, 'expiredate'),
        cost: cellOf(tr, 'cost'),
      });
    }
    return rows;
  }

  function readTotalCount(table) {
    const match = /\d+/.exec(textOf(table.querySelector('.table-header__total')));
    return match ? parseInt(match[0], 10) : null;
  }

  // <isp-balance> renders the amount in one of two elements: the plain one, or, for accounts
  // with a credit limit, the "with-credit" variant that also carries credit/late-payment text.
  function readBalance() {
    const root = document.querySelector('isp-balance');
    if (!root) return null;
    const amount = root.querySelector('.isp-balance-without-credit__amount, .isp-balance-with-credit__balance');
    return parseMoney(textOf(amount || root));
  }

  function render(panel, view) {
    const { model, balance, today, shown, total } = view;
    const fallbackCurrency = Object.keys(model.monthly)[0] || (balance && balance.currency) || '';
    const positiveTopUp = Object.fromEntries(Object.entries(model.topUp).filter(([, cents]) => cents > 0));
    const covered = Object.keys(positiveTopUp).length === 0;

    const leftover = balance && Object.keys(model.due).length
      ? formatMoney(balance.cents - (Object.values(model.due)[0] || 0), balance.currency)
      : null;

    const select = h(
      'select',
      {
        class: 'sbt-select',
        'aria-label': 'На сколько месяцев вперёд считать',
        onchange: (e) => {
          state.months = Number(e.target.value);
          store.set('months', state.months);
          update();
        },
      },
      HORIZONS.map((n) => {
        const option = h('option', { value: n }, `ещё ${n} мес`);
        option.selected = n === state.months;
        return option;
      }),
    );

    const tiles = [
      h('div', { class: 'sbt-tile' },
        h('div', { class: 'sbt-label' }, 'Стоимость в месяц'),
        h('div', { class: 'sbt-value' }, formatMoneyMap(model.monthly, fallbackCurrency)),
        h('div', { class: 'sbt-sub' }, `${model.items.length} ${plural(model.items.length, 'услуга', 'услуги', 'услуг')}`)),
      h('div', { class: 'sbt-tile' },
        h('div', { class: 'sbt-label' }, 'Чтобы всё работало', select),
        h('div', { class: 'sbt-value' }, formatMoneyMap(model.due, fallbackCurrency)),
        h('div', { class: 'sbt-sub' }, `до ${formatDate(model.horizon)} · продлить ${model.dueCount} из ${model.items.length}`),
        model.nextExpiry && h('div', { class: 'sbt-sub' },
          `ближайшее: ${formatDate(model.nextExpiry)} (${daysUntil(model.nextExpiry, today)})`)),
      h('div', { class: 'sbt-tile' },
        h('div', { class: 'sbt-label' }, 'Баланс'),
        h('div', { class: 'sbt-value' }, balance ? formatMoney(balance.cents, balance.currency) : '—'),
        !balance && h('div', { class: 'sbt-sub' }, 'не найден на странице')),
      h('div', { class: 'sbt-tile' },
        h('div', { class: 'sbt-label' }, 'Пополнить на'),
        covered
          ? h('div', { class: 'sbt-value sbt-value--ok' }, '✓ хватает')
          : h('div', { class: 'sbt-value sbt-value--due' }, formatMoneyMap(positiveTopUp, fallbackCurrency)),
        covered && leftover && h('div', { class: 'sbt-sub' }, `останется ${leftover}`)),
    ];

    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'sbt-toggle',
        'aria-expanded': String(state.open),
        onclick: () => {
          state.open = !state.open;
          store.set('open', state.open);
          update();
        },
      },
      state.open ? 'Скрыть ▴' : 'Подробнее ▾',
    );

    const warnings = [];
    if (total != null && shown < total) {
      warnings.push(`Загружено ${shown} из ${total} строк — прокрутите список или откройте остальные страницы, итог пока неполный.`);
    }
    if (model.issues.noPrice) warnings.push(`Не удалось разобрать цену у услуг: ${model.issues.noPrice}.`);
    if (model.issues.guessedPeriod) warnings.push(`Период оплаты не распознан у услуг: ${model.issues.guessedPeriod}, считаю его месяцем.`);

    const sorted = model.items.slice().sort((a, b) => (a.expire || Infinity) - (b.expire || Infinity));
    const details = h('div', { class: 'sbt-details' },
      h('table', { class: 'sbt-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Услуга'),
          h('th', {}, 'Действует до'),
          h('th', { class: 'sbt-num' }, 'Цена'),
          h('th', { class: 'sbt-num' }, 'Продлений'),
          h('th', { class: 'sbt-num' }, 'К оплате'))),
        h('tbody', {}, sorted.map((item) => h('tr', {},
          h('td', {}, item.name, item.note && h('span', { class: 'sbt-muted' }, `  ${item.note}`)),
          h('td', {}, item.expire ? formatDate(item.expire) : '—'),
          h('td', { class: 'sbt-num' }, formatMoney(item.cost.cents, item.cost.currency)),
          h('td', { class: 'sbt-num' }, String(item.renewals)),
          h('td', { class: 'sbt-num' }, item.dueCents ? formatMoney(item.dueCents, item.cost.currency) : '—')))),
        h('tfoot', {}, h('tr', {},
          h('td', { colspan: 4 }, 'Итого к оплате'),
          h('td', { class: 'sbt-num' }, formatMoneyMap(model.due, fallbackCurrency))))));

    panel.classList.toggle('sbt-open', state.open);
    panel.replaceChildren(
      h('div', { class: 'sbt-row' }, tiles, h('div', { class: 'sbt-spacer' }), toggle),
      ...warnings.map((w) => h('div', { class: 'sbt-warn' }, `⚠ ${w}`)),
      details,
    );
  }

  function update() {
    const balance = readBalance();
    const today = startOfDay(new Date());

    for (const table of document.querySelectorAll('isp-table')) {
      const next = table.nextElementSibling;
      let panel = next && next.classList.contains(PANEL_CLASS) ? next : null;

      const rows = readRows(table);
      if (!rows.length) {
        if (panel) panel.remove();
        continue;
      }

      const model = analyze(rows, { today, months: state.months, balance });
      const view = { model, balance, today, shown: rows.length, total: readTotalCount(table) };
      const signature = JSON.stringify([view, state.open]);

      if (!panel) {
        panel = h('div', { class: PANEL_CLASS, role: 'region', 'aria-label': 'Итоги по услугам' });
        table.after(panel);
      }
      if (panel.dataset.signature !== signature) {
        panel.dataset.signature = signature;
        render(panel, view);
      }
    }
  }

  let timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      try {
        update();
      } catch (e) {
        console.error('[senko-billmgr-totals]', e);
      }
    }, 250);
  }

  const insideOurPanel = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return !!element && !!element.closest('.' + PANEL_CLASS);
  };

  document.head.append(h('style', { id: 'sbt-style' }, STYLE));
  new MutationObserver((mutations) => {
    if (!mutations.every((m) => insideOurPanel(m.target))) schedule();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
})();
