#!/usr/bin/env node
// Operator CLI for support tasks. Runs inside the container against the live DB:
//   docker exec docforge node deploy/admin.js info someone@example.com
// SQLite WAL + busy_timeout make it safe to run while the server is up.
const { openDb, Store, currentMonth } = require('../src/db');
const { PLANS } = require('../src/plans');

const USAGE = `Usage: node deploy/admin.js <command> [args]

  info <email>                 show account, plan, status, source and this month's usage
  rotate <email>               issue a new API key (the old one stops working) and print it
  set-plan <email> <plan>      set the plan manually (${Object.keys(PLANS).join('|')})
  suspend <email>              block API access (403 account_suspended)
  unsuspend <email>            restore API access
  delete <email> --yes         permanently delete the account, its templates, usage and
                               recovery tokens (cancel any Lemon Squeezy subscription first)`;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function main(argv) {
  const [cmd, rawEmail, arg] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  if (!['info', 'rotate', 'set-plan', 'suspend', 'unsuspend', 'delete'].includes(cmd)) fail(`Unknown command: ${cmd}\n\n${USAGE}`, 2);
  if (!rawEmail) fail(`Missing <email>\n\n${USAGE}`, 2);

  const store = new Store(openDb());
  const email = String(rawEmail).trim().toLowerCase();
  const acc = store.accountByEmail(email);
  if (!acc) fail(`No account with email ${email}`);

  switch (cmd) {
    case 'info': {
      const plan = PLANS[acc.plan] || PLANS.free;
      console.log(JSON.stringify({
        id: acc.id,
        email: acc.email,
        plan: acc.plan,
        status: acc.status || 'active',
        source: acc.source ?? null,
        subscription_id: acc.subscription_id ?? null,
        key_prefix: acc.key_prefix,
        created_at: acc.created_at,
        month: currentMonth(),
        renders_used: store.usage(acc.id),
        renders_limit: plan.monthlyRenders,
        templates: store.countTemplates(acc.id),
      }, null, 2));
      break;
    }
    case 'rotate': {
      const key = store.rotateKey(acc.id);
      console.log(key);
      console.error(`Rotated key for ${email}; the previous key no longer works. Send this one over a private channel.`);
      break;
    }
    case 'set-plan': {
      if (!arg || !Object.hasOwn(PLANS, arg)) fail(`Plan must be one of: ${Object.keys(PLANS).join(', ')}`, 2);
      store.setPlan(acc.id, arg);
      console.log(`${email}: plan ${acc.plan} -> ${arg}`);
      if (acc.subscription_id) {
        console.error('Note: this account has a Lemon Squeezy subscription; the next webhook for it may change the plan again.');
      }
      break;
    }
    case 'delete': {
      if (acc.subscription_id) {
        console.error(`Warning: subscription ${acc.subscription_id} must be cancelled in Lemon Squeezy first, or the customer keeps being charged.`);
      }
      if (arg !== '--yes') fail(`This permanently deletes ${email}. Re-run with --yes to confirm.`, 2);
      store.deleteAccount(acc.id);
      console.log(`${email}: deleted (id ${acc.id}${acc.subscription_id ? `, subscription ${acc.subscription_id}` : ''}). Snapshots age out of backups within 7 days.`);
      break;
    }
    case 'suspend':
    case 'unsuspend': {
      const status = cmd === 'suspend' ? 'suspended' : 'active';
      store.setStatus(acc.id, status);
      console.log(`${email}: status ${acc.status || 'active'} -> ${status}`);
      break;
    }
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    fail(`Error: ${e.message}`);
  }
}

module.exports = { main };
