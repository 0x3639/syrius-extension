# Syrius Extension — refactor log

Working notes for the modernisation pass. Kept current as work lands so the
state is legible without re-reading every diff.

## Agreed scope

- **Feature parity target:** wallet-core parity with desktop Syrius, **minus
  Sentinels**. In: all-ZTS token list, change wallet password, reset/remove
  wallet, address labels, auto-receive. Out: Sentinels, Accelerator-Z, P2P/HTLC
  swaps, WalletConnect.
- **dApp injection:** inject on all sites, gate every origin behind an explicit
  connect prompt, persist per-origin permissions, expose a Connected Sites
  screen. (Chosen over the current single-domain allowlist.)

## Baseline (before this pass)

| | |
|---|---|
| popup bundle | 7.95 MiB |
| vendors bundle | 6.91 MiB |
| popup entrypoint total | **14.9 MiB** |
| production build | 33 s |
| time to first interaction | ~3 s splash, then Argon2id unlock |

Known-bad from `../zenon-docs/security/syrius-extension-audit.md`: MV3 `window.open` in the
service worker (already fixed in the working tree), an unauthenticated
plaintext-password oracle in the background script, and a suspected
blob-worker/CSP break in Plasma PoW.

## Plan

### A. Build and bundle hygiene
- [x] Drop the unreachable `newtab` / `options` / `panel` / `devtools` entry
      points and their sources; drop `devtools_page` from the manifest.
- [x] Vendor chunk only for the popup — the content and page scripts must stay
      standalone.
- [x] `drop_console` for log/debug/info in production; no source maps in
      production.
- [x] Remove `three` (password-screen 3D ball) and `react-lottie-player`
      (splash) — the two largest avoidable dependencies. Also dropped
      `framer-motion`, `react-hot-loader`, `@hot-loader/react-dom`,
      `react-transition-group`, `webpack-obj-loader`.
- [x] Delete now-unused assets (3D models, cyber-eye textures, Lottie files).
- [x] Fix module resolution for the symlinked `znn-ts-sdk`: it is a `file:`
      dependency with no node_modules of its own, so following the symlink made
      webpack resolve its imports outside this project and fail on
      `process/browser`. `resolve.symlinks: false` plus explicit aliases.

### B. Core services
- [x] `services/utils/format.js` — one BigNumber-correct amount formatter and
      parser, replacing ~20 copies of a nested `formatUnits` expression.
- [x] `services/utils/errors.js` — one readable-error helper (~10 copies).
- [x] `services/utils/notify.js` — one toast helper (~20 copies).
- [x] `services/utils/explorer.js` — explorer links that follow the chain.
- [x] `services/wallet/vault.js` — decrypt the keystore **once** and cache the
      derived key pair, instead of running Argon2id on every screen.
- [x] `services/wallet/session.js` — unlock that survives service-worker
      restarts, with a real auto-lock.
- [x] `services/hooks/useAccount.js` — shared address/balance loading.

### C. Background service worker
- [x] Rewrite as a router with `sender` validation (audit finding #2).
- [x] Per-origin permission store.
- [x] Reuse a single approval window instead of stacking popups.

### D. dApp provider
- [x] Real `window.zenon` provider: `request()`, events, connect/disconnect.
- [x] Content-script relay with origin checks; legacy postMessage kept working.

### E. UI / UX
- [x] Instant open (no splash), fixed 360×600 shell, scrolling contained to the
      screen body so the header and tab bar stay put.
- [x] One icon set (`components/icon`) replacing brand marks used as icons.
- [x] Stylesheet rewritten: 1801 lines of `!important` utilities and dead
      classes down to a token-driven system.
- [x] Header: account pill, network chip, lock.
- [x] Bottom nav without the artificial 300 ms navigation delay.
- [x] Dashboard, Send (precision + address validation), Receive, Tokens.
- [x] Settings: change password, reset wallet, connected sites, labels,
      auto-lock.

## Bugs found while reading (to fix)

1. `send.js` — amount converted with `parseInt(amount * 10**decimals)`; binary
   floating point loses a base unit on values like `4.35`. Max send is also
   hardcoded to `999`.
2. `send.js` — recipient address is only checked for presence, never parsed.
3. `plasma.js` — the fuse field's `onChange` writes `qsrAmount` into the form
   instead of the typed value, so its validation never sees what was typed.
4. `delegate.js` — ZNN reward is divided by the QSR token's decimals and vice
   versa (both are 8 today, so it is latent, not visible).
5. `siteIntegrationLayout.js` — indexes `balanceInfoMap[tokenStandard]`
   unguarded; a request for a token the account does not hold throws.
6. `transaction-item.js` — explorer link is hardcoded to the mainnet explorer
   regardless of the chain in use.
7. `receive.js` — claims the address "can only be used to receive ZNN or QSR".
8. `dashboard.js` / `delegate.js` / `plasma.js` — `useState` arrays reassigned
   through a `let` binding and mutated.
9. `burger-popover.js` — "Help&Support" is inert.

## Additional shared code extracted

- `services/hooks/useBlockSender.js` — one signing/plasma-progress path,
  replacing six copies.
- `services/hooks/usePagedList.js` — one paginated list, replacing four copies
  that all had the same "more pages" bug.
- `services/hooks/useTransactions.js`, `useNodeList.js`, `components/node-list`.
- `services/utils/storage.js`, `messaging.js`; `services/wallet/{bootstrap,
  announce,lock,account}.js`.
- The spinner and modal hooks were toggles over stale closures; they are
  counted show/hide pairs now.

## Bugs found while running it (not visible by reading)

18. **Sending used the wrong address.** `vault` defaulted every accessor to
    index 0 while the balances came from the selected index, so a wallet on its
    second address showed one account and signed with another. Six call sites
    had the same defect. Fixed at the root: the vault holds the selected index
    and it is the default for every accessor.
19. **A dead message channel hung the wallet forever.** `sendInternal` had no
    deadline, and `completeUnlock` awaited it. When a page's extension context
    is orphaned — which is what an extension update does to an open popup —
    `chrome.runtime.sendMessage`'s callback is never invoked, and the wallet sat
    on a blank splash with no error and no way forward. Every call now has a
    deadline, and telling sites about an unlock no longer blocks it.
20. **The internal sender check was wrong.** It gated on `!sender.tab`, which
    refuses an extension page opened in a tab rather than as a toolbar popup.
    It tests the sender's own extension-origin URL now, which is both correct
    and stricter.

## Bugs found while reading (fixed unless noted)

10. `get-started.js` / `recovery.js` — `saveKeyStore` was never awaited, so the
    flow advanced before the wallet was written.
11. `recovery.js` — a recovery phrase was accepted on word count alone, with no
    BIP-39 checksum check: one mistyped word silently imported a *different*,
    empty wallet and reported success.
12. `stake.js` — `parseInt(amount) * 1e8`, so staking 1.5 ZNN staked 1.0.
13. `stake.js` — "Staked N ZNN" read a state value that was never assigned, so
    the figure was always zero.
14. `token-dropdown.js` — compared a `TokenStandard` object to a string, so the
    control never showed the selected token.
15. `custom-dropdown.js` — an effect keyed on `value` called `onChange`,
    re-entering form validation on every render.
16. `storage` — `loadStorageAddressInfo` tested `selectedAddressIndex` for
    truthiness, resetting any wallet sitting on address 0 back to defaults.
17. Background — the credential cache lived in a service-worker module variable
    and so evaporated at random, which is why the password prompt reappeared
    unpredictably.

## Measurements

| | before | after |
|---|---|---|
| popup entrypoint | 14.9 MiB | **6.1 MiB** |
| popup bundle | 7.95 MiB | 139 KiB |
| production build | 33 s | 21 s |
| keystore decryptions per navigation | 1 (Argon2id, 64 MiB) | 0 |

## Verification

Run against the go-zenon devnet (`ws://localhost:35998`, chain 69) through
`utils/dev-harness.js`, not by inspection.

**Amount precision, confirmed on-chain.** Sent 4.35 ZNN from the wallet UI and
read the account back from the node:

```
balance before   980800000000
balance after    980365000000
difference          435000000   <- exactly 4.35 ZNN
```

The previous code built this block with `parseInt(4.35 * 1e8)`, which is
434999999 — a base unit short, silently.

**dApp bridge, end to end.** `utils/dapp-test.js` drives a real page against the
injected provider: provider present, `getAccounts()` empty before connecting,
read-only `getChainId()` with no prompt, approval window opened and naming the
origin, the page's `connect()` promise resolving with the address, and a second
`connect()` from a granted origin resolving with no new prompt. All pass.

**Audit finding #6 is not a real defect.** The audit flagged, unverified, that
MV3's CSP might block the blob-URL Web Worker the SDK builds for plasma proof of
work. Constructed one inside the extension page under the shipped CSP: it runs.
The blob inherits the extension's own origin, which `script-src 'self'` covers.

**Audit finding #2 is closed.** The plaintext-password oracle is gone with the
credential cache itself; the wallet's own control surface is now gated on the
sender's extension-origin URL.

Also fixed in the harness: `dev:reload` rebuilt and navigated the popup but did
not reload the extension, so the service worker kept running the previous build
and the popup was left bound to an extension generation that no longer existed.
And its devnet wallet had no chain identifier, so every block it signed carried
mainnet's chain 1 and the devnet rejected it.

## Transaction history (second pass)

The history said almost nothing true. Four changes, all of them about the same
thing: the wallet knew the destination of a block but never looked at what the
block actually *did*.

- **Method-level labels.** An embedded call is prefixed with four bytes
  identifying the function — the first four of `SHA3-256` over its canonical
  signature, which is how go-zenon dispatches it. `services/utils/contractCalls.js`
  matches on that, so **Fused / Unfused**, **Staked / Unstaked**, **Delegated /
  Undelegated** are now distinct rows. Previously both halves of each pair
  rendered as the same word, and everything else rendered as "Sent 0".
  Signatures are transcribed from `go-zenon/vm/embedded/definition/*.go` and
  verified against it by `npm test`; the derivation was checked against the SDK
  by encoding real calls through it.
- **HTLC.** `znn-ts-sdk` has no HTLC support of any kind — no address constant,
  no ABI, no helper — but an HTLC call is an embedded call like any other, so
  `Create`, `Unlock`, `Reclaim`, `DenyProxyUnlock` and `AllowProxyUnlock` are
  identified from the same four bytes and shown as **Swap created / unlocked /
  reclaimed**. All five are covered by `npm test`.
- **Unconfirmed transactions.** A block the network had not settled looked
  exactly like one it had. `confirmationDetail` is absent until a momentum
  covers the block, so a row without one gets a pulsing dot with an
  "Unconfirmed" bubble on hover — and the dashboard polls only while at least
  one row is pending, folding the refreshed page in by hash so the pulse clears
  itself without losing the pages already scrolled through.
- **Explorer links** default to zenonhub.io and are switchable under Settings.
  They were hard-coded to explorer.zenon.network for every chain, so on any
  non-mainnet chain every row linked to a page that does not exist; they are now
  omitted entirely off mainnet rather than rendered dead.
- Zero amounts are no longer printed: a contract call carries a zero-value
  block, and "0 QSR" next to an unfuse reads as a transfer that failed.
- An embedded contract is named rather than shown as forty characters of
  `z1qxemdedded…` — "From Plasma", not "From z1qxem…sctrp".

## Not done (out of the agreed scope)

Sentinels, Accelerator-Z, P2P/HTLC swaps and WalletConnect. The first was
excluded by request; the rest are desktop-shaped features that do not fit a
360px popup and each amount to a project of their own.
