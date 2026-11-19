'use strict';

/**
 * policy.js — OATHKEEPER's deterministic policy engine.
 *
 * Plain code, NOT an LLM. The agent may propose transactions, but every
 * autonomous decision is made here, and every decision this engine makes
 * is exactly the statement the ZK circuit proves:
 *
 *   ALLOW (1)  iff  amount <= limit AND category not in blockedCats
 *   BLOCK (0)  otherwise
 *
 * Amounts are integer cents. Category codes are small integers starting
 * at 1 (0 is reserved as the "empty slot" padding in the circuit).
 */

const CATEGORIES = {
  groceries: 1,
  games: 2,
  gambling: 3,
  subscriptions: 4,
  software: 5,
  transfers: 6,
  dining: 7,
  other: 8,
};

const CODE_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORIES).map(([name, code]) => [code, name]),
);

const DEFAULT_POLICY = {
  limitCents: 5000, // $50.00
  blockedCategories: ['gambling', 'subscriptions'],
};

/** Map category names to the fixed 8-slot code array the circuit expects. */
function blockedSlots(policy) {
  const codes = (policy.blockedCategories || [])
    .map((name) => CATEGORIES[name])
    .filter((code) => Number.isInteger(code));
  const slots = [...new Set(codes)].slice(0, 8);
  while (slots.length < 8) slots.push(0);
  return slots;
}

/**
 * Evaluate a proposed transaction against the private policy.
 * @returns {{decision:'ALLOW'|'BLOCK', decisionBit:1|0, rule:string, reason:string}}
 */
function evaluate(tx, policy) {
  const amount = Number(tx.amountCents);
  const categoryName = tx.category;
  const code = CATEGORIES[categoryName];

  if (!Number.isInteger(amount) || amount <= 0) {
    return verdict('BLOCK', 0, 'invalid-amount', 'Amount must be a positive integer number of cents.');
  }
  if (code === undefined) {
    return verdict('BLOCK', 0, 'unknown-category', `Category "${categoryName}" is not a recognised category.`);
  }
  if ((policy.blockedCategories || []).includes(categoryName)) {
    return verdict('BLOCK', 0, 'blocked-category',
      `Category "${categoryName}" is on the owner's private block list.`);
  }
  if (amount > policy.limitCents) {
    return verdict('BLOCK', 0, 'above-cap',
      `$${(amount / 100).toFixed(2)} is above the owner's private per-transaction cap.`);
  }
  return verdict('ALLOW', 1, 'within-limits',
    `$${(amount / 100).toFixed(2)} is within the owner's private cap and "${categoryName}" is not blocked.`);
}

function verdict(decision, decisionBit, rule, reason) {
  return { decision, decisionBit, rule, reason };
}

module.exports = { evaluate, blockedSlots, CATEGORIES, CODE_TO_CATEGORY, DEFAULT_POLICY };
