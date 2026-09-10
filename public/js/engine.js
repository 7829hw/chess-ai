/**
 * Stockfish transport layer.
 *
 * Owns the single Web Worker running the Stockfish WASM build and speaks UCI
 * to it. This module knows nothing about chess rules, the DOM, or the game
 * flow -- it only turns UCI text into promises.
 *
 * Stability guarantees provided here:
 *  - exactly one Worker per instance, even under concurrent `init()` calls;
 *  - every search carries a sequence number, so a `bestmove` belonging to a
 *    superseded search can never be handed back to the caller;
 *  - handshake and search both time out instead of hanging forever;
 *  - `bestmove (none)` is reported as `null` rather than crashing the caller.
 */

import {
  APP_VERSION,
  ENGINE_HASH_MB,
  HANDSHAKE_TIMEOUT_MS,
  SEARCH_TIMEOUT_MARGIN_MS,
} from './constants.js';

const ENGINE_DIR = '../stockfish/';
const ENGINE_SCRIPT = 'stockfish-18-lite-single.js';
const ENGINE_WASM = 'stockfish-18-lite-single.wasm';

/**
 * Absolute URLs derived from this module's own location, so the app keeps
 * working when it is hosted under a sub-path and never depends on the
 * document's base URL.
 */
const WORKER_SCRIPT_URL = new URL(ENGINE_DIR + ENGINE_SCRIPT, import.meta.url);
const WORKER_WASM_URL = new URL(ENGINE_DIR + ENGINE_WASM, import.meta.url);

/**
 * The stockfish.js worker reads the WASM location from its own URL fragment
 * (`#<encoded-url>`), falling back to `location.pathname` with `.js` swapped
 * for `.wasm`. Passing it explicitly removes any ambiguity about how a
 * relative path is resolved *inside* the worker, and the `?v=` query busts
 * stale copies of the worker script itself without touching the (content
 * stable, hard cached) binary.
 */
function buildWorkerUrl() {
  const url = new URL(WORKER_SCRIPT_URL.href);
  url.searchParams.set('v', APP_VERSION);
  url.hash = encodeURIComponent(WORKER_WASM_URL.href);
  return url.href;
}

const UCI_OK = 'uciok';
const READY_OK = 'readyok';

export class EngineError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'EngineError';
    this.cause = cause;
  }
}

export class StockfishEngine {
  /** @type {Worker | null} */
  #worker = null;
  /** @type {Promise<void> | null} */
  #initPromise = null;
  #ready = false;
  #disposed = false;
  /** @type {EngineError | null} */
  #fatal = null;

  /** Pending one-shot line matchers (uciok / readyok). */
  #waiters = [];

  /** Monotonic search id. Anything older than this is stale by definition. */
  #searchSeq = 0;
  /** @type {{seq:number,resolve:Function,reject:Function,timer:number}|null} */
  #activeSearch = null;

  /**
   * @param {object} [hooks]
   * @param {(info: {depth?:number, scoreCp?:number, scoreMate?:number}) => void} [hooks.onSearchInfo]
   * @param {(error: EngineError) => void} [hooks.onFatalError]
   */
  constructor({ onSearchInfo, onFatalError } = {}) {
    this.onSearchInfo = onSearchInfo ?? null;
    this.onFatalError = onFatalError ?? null;
  }

  get isReady() {
    return this.#ready && !this.#fatal;
  }

  get isSearching() {
    return this.#activeSearch !== null;
  }

  /**
   * Boots the worker and completes the UCI handshake. Safe to call repeatedly:
   * the same promise (and the same Worker) is reused.
   * @returns {Promise<void>}
   */
  init() {
    if (this.#disposed) return Promise.reject(new EngineError('Engine has been disposed'));
    if (!this.#initPromise) {
      this.#initPromise = this.#boot().catch((error) => {
        // Keep the rejection sticky so later callers see the same failure
        // instead of silently spawning a second worker.
        this.#registerFatal(error);
        throw this.#fatal;
      });
    }
    return this.#initPromise;
  }

  async #boot() {
    const workerUrl = buildWorkerUrl();
    console.info('[engine] starting worker', workerUrl);

    try {
      this.#worker = new Worker(workerUrl);
    } catch (error) {
      throw new EngineError('Could not start the Stockfish Web Worker', error);
    }

    this.#worker.onmessage = (event) => this.#handleMessage(event.data);
    this.#worker.onerror = (event) => {
      event.preventDefault?.();
      this.#registerFatal(
        new EngineError(`Stockfish worker error: ${event.message ?? 'unknown'}`, event),
      );
    };
    this.#worker.onmessageerror = () => {
      this.#registerFatal(new EngineError('Stockfish worker sent an undecodable message'));
    };

    const handshake = this.#waitForLine((line) => line === UCI_OK, HANDSHAKE_TIMEOUT_MS, UCI_OK);
    this.#post('uci');
    await handshake;

    // Single-threaded build: pin Threads to 1 and keep the hash table small.
    this.#post('setoption name Threads value 1');
    this.#post(`setoption name Hash value ${ENGINE_HASH_MB}`);
    this.#post('setoption name Ponder value false');

    await this.#synchronize(HANDSHAKE_TIMEOUT_MS);
    this.#ready = true;
    console.info('[engine] ready');
  }

  /**
   * Resets the engine for a fresh game and applies the difficulty preset.
   * @param {{ skillLevel: number }} options
   */
  async newGame({ skillLevel }) {
    this.#assertUsable();
    this.cancelSearch();
    this.#post(`setoption name Skill Level value ${clampSkill(skillLevel)}`);
    this.#post('ucinewgame');
    await this.#synchronize(HANDSHAKE_TIMEOUT_MS);
    console.info('[engine] ucinewgame, skill level', clampSkill(skillLevel));
  }

  /**
   * Adjusts strength without resetting the game. Ignored while searching, so
   * the option can never race with an in-flight `go`.
   * @param {number} skillLevel
   */
  setSkillLevel(skillLevel) {
    if (!this.isReady || this.isSearching) return false;
    this.#post(`setoption name Skill Level value ${clampSkill(skillLevel)}`);
    return true;
  }

  /**
   * Runs one search.
   *
   * @param {object} options
   * @param {string[]} options.moves    Game history in UCI long algebraic form.
   * @param {number}   options.depth
   * @param {number}   options.movetime  Milliseconds.
   * @returns {Promise<{seq:number, bestmove:string|null, aborted:boolean}>}
   *          `bestmove` is `null` for `bestmove (none)` or for an aborted search.
   */
  search({ moves, depth, movetime }) {
    this.#assertUsable();
    if (!this.#ready) {
      return Promise.reject(new EngineError('Refusing to search before the engine is ready'));
    }

    // Any search still running is by definition obsolete now.
    this.cancelSearch();

    const seq = ++this.#searchSeq;
    const position = moves.length > 0
      ? `position startpos moves ${moves.join(' ')}`
      : 'position startpos';

    return new Promise((resolve, reject) => {
      const timeoutMs = movetime + SEARCH_TIMEOUT_MARGIN_MS;
      const timer = setTimeout(() => {
        if (this.#activeSearch?.seq !== seq) return;
        this.#activeSearch = null;
        this.#post('stop');
        reject(new EngineError(`Stockfish did not answer within ${timeoutMs}ms`));
      }, timeoutMs);

      // The pending search must be registered before `go` is written, or a
      // fast reply could arrive with nowhere to land.
      this.#activeSearch = { seq, resolve, reject, timer };

      try {
        this.#post(position);
        this.#post(`go depth ${depth} movetime ${movetime}`);
      } catch (error) {
        clearTimeout(timer);
        this.#activeSearch = null;
        reject(error);
      }
    });
  }

  /**
   * Abandons the running search (if any). The `bestmove` it eventually emits
   * is dropped on arrival, which is what keeps a previous game's reply from
   * landing on a new board.
   */
  cancelSearch() {
    const pending = this.#activeSearch;
    this.#activeSearch = null;
    this.#searchSeq += 1;

    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ seq: pending.seq, bestmove: null, aborted: true });
      if (this.#worker) this.#post('stop');
      console.debug('[engine] search', pending.seq, 'cancelled');
    }
  }

  /** Terminates the worker. The instance is unusable afterwards. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelSearch();
    this.#rejectWaiters(new EngineError('Engine disposed'));
    if (this.#worker) {
      try {
        this.#post('quit');
      } catch {
        /* worker may already be gone */
      }
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#ready = false;
  }

  // ------------------------------------------------------------------ internals

  #assertUsable() {
    if (this.#disposed) throw new EngineError('Engine has been disposed');
    if (this.#fatal) throw this.#fatal;
  }

  #post(command) {
    if (!this.#worker) throw new EngineError('Stockfish worker is not running');
    console.debug('[engine] >>', command);
    this.#worker.postMessage(command);
  }

  /** `isready` round-trip; guarantees the engine drained all prior commands. */
  #synchronize(timeoutMs) {
    // Waiter first, command second: never race the reply.
    const synced = this.#waitForLine((line) => line === READY_OK, timeoutMs, READY_OK);
    this.#post('isready');
    return synced;
  }

  #waitForLine(predicate, timeoutMs, label) {
    if (this.#fatal) return Promise.reject(this.#fatal);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new EngineError(`Timed out waiting for "${label}" from Stockfish`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #handleMessage(data) {
    if (typeof data !== 'string') return;

    for (const line of data.split('\n')) {
      const text = line.trim();
      if (text) this.#handleLine(text);
    }
  }

  #handleLine(line) {
    if (line.startsWith('info')) {
      this.#handleInfo(line);
      return;
    }

    if (line.startsWith('bestmove')) {
      this.#handleBestMove(line);
      return;
    }

    console.debug('[engine] <<', line);

    const matched = this.#waiters.filter((w) => w.predicate(line));
    if (matched.length === 0) return;
    this.#waiters = this.#waiters.filter((w) => !matched.includes(w));
    for (const waiter of matched) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  #handleInfo(line) {
    if (!this.onSearchInfo) return;
    const depth = /\bdepth (\d+)/.exec(line);
    const cp = /\bscore cp (-?\d+)/.exec(line);
    const mate = /\bscore mate (-?\d+)/.exec(line);
    if (!depth && !cp && !mate) return;
    this.onSearchInfo({
      depth: depth ? Number(depth[1]) : undefined,
      scoreCp: cp ? Number(cp[1]) : undefined,
      scoreMate: mate ? Number(mate[1]) : undefined,
    });
  }

  #handleBestMove(line) {
    const pending = this.#activeSearch;
    this.#activeSearch = null;

    // No pending search means this is the tail of a cancelled/aborted one.
    if (!pending) {
      console.debug('[engine] dropped stale', line);
      return;
    }

    clearTimeout(pending.timer);
    console.debug('[engine] <<', line);

    const token = line.split(/\s+/)[1];
    const isNone = !token || token === '(none)';
    const stale = pending.seq !== this.#searchSeq;

    pending.resolve({
      seq: pending.seq,
      bestmove: isNone || stale ? null : token,
      aborted: stale,
    });
  }

  #registerFatal(error) {
    const wrapped = error instanceof EngineError
      ? error
      : new EngineError('Stockfish engine failure', error);

    if (this.#fatal) return;
    this.#fatal = wrapped;
    this.#ready = false;
    console.error('[engine]', wrapped.message, wrapped.cause ?? '');

    const pending = this.#activeSearch;
    this.#activeSearch = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.#rejectWaiters(wrapped);
    this.onFatalError?.(wrapped);
  }

  #rejectWaiters(error) {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function clampSkill(level) {
  const value = Number.isFinite(level) ? Math.round(level) : 20;
  return Math.min(20, Math.max(0, value));
}
