// SpacetimeDB connection shared by the laptop and phone pages.
// By default the database is reached through this page's own origin (Vite proxies /v1 to the local
// SpacetimeDB), so one HTTPS tunnel serves both the pages and the database. Set VITE_STDB_URI to use
// maincloud or another host instead.
import { DbConnection, tables } from './module_bindings/index.ts';

const DB_NAME = import.meta.env.VITE_STDB_DB || 'birdie-blitz';
const URI = import.meta.env.VITE_STDB_URI || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// sessionStorage: every browser tab is its own identity (two players can test on one laptop),
// and a reload or a reconnect keeps the same identity — that is what lets a dropped phone resume.
const TOKEN_KEY = `bb/${URI}/${DB_NAME}/token`;
const store = (() => { try { return window.sessionStorage; } catch { return undefined; } })();
const getToken = () => { try { return store?.getItem(TOKEN_KEY) || undefined; } catch { return undefined; } };
const setToken = t => { try { store?.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };

export { tables };

/**
 * Connects, subscribes to `subs` (table refs) and keeps reconnecting with the same identity.
 * Callbacks: onReady(conn, identityHex) after every (re)subscription, onStatus(text|null).
 * `wire(conn)` registers table callbacks; it runs once per connection object.
 */
export function connect({ subs, wire, onReady, onStatus }) {
  let retry = 0;
  const open = () => {
    onStatus?.('Connecting to SpacetimeDB…');
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB_NAME)
      .withToken(getToken())
      .onConnect((c, identity, token) => {
        setToken(token);
        retry = 0;
        c.subscriptionBuilder()
          .onApplied(() => { onStatus?.(null); onReady?.(c, identity.toHexString()); })
          .onError((_ctx, err) => console.error('Subscription error', err))
          .subscribe(subs);
      })
      .onDisconnect(() => { onStatus?.('Reconnecting…'); setTimeout(open, Math.min(4000, 500 * 2 ** retry++)); })
      .onConnectError((_ctx, err) => {
        console.error('SpacetimeDB connection failed', err);
        onStatus?.('Can’t reach SpacetimeDB — retrying…');
        setTimeout(open, Math.min(4000, 500 * 2 ** retry++));
      })
      .build();
    wire?.(conn);
  };
  open();
}

/** Calls a reducer and turns server-side SenderErrors into a readable message. */
export function call(conn, name, args, onError) {
  if (!conn) { onError?.('Not connected yet'); return; }
  try {
    Promise.resolve(conn.reducers[name](args)).catch(e => onError?.(clean(e)));
  } catch (e) { onError?.(clean(e)); }
}
const clean = e => (e instanceof Error ? e.message : String(e)).replace(/^.*?SenderError:?\s*/i, '');
