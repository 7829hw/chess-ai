const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://chess';
const OUT = process.env.OUT || '/work/out';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });

  const engineScriptHits = [];
  const failedRequests = [];
  const pageErrors = [];
  page.on('request', (r) => {
    if (r.url().includes('stockfish-18-lite-single.js')) engineScriptHits.push(r.url());
  });
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.url()} -> ${r.status()}`); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  const layout = () => page.$$eval('#board .square', (els) =>
    els.map((e) => ({ sq: e.dataset.square, piece: e.dataset.piece || null })));
  const banner = () => page.$eval('#status-banner', (e) => e.textContent.trim());
  const moves = () => page.$$eval('#move-list .move-san', (els) => els.map((e) => e.textContent));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  check('loading banner shown', /엔진 로딩 중/.test(await banner()), await banner());

  // Engine boots, first game auto-starts with the user as White.
  await page.waitForFunction(
    () => document.getElementById('status-banner').textContent.includes('내 차례'),
    null, { timeout: 180000 });
  check('engine reached ready + player turn', true, await banner());

  // ---- orientation: user is White and must be on TOP ----
  let grid = await layout();
  check('white-user: top-left square is h1', grid[0].sq === 'h1', grid[0].sq);
  check('white-user: top-right square is a1', grid[7].sq === 'a1', grid[7].sq);
  check('white-user: bottom-left square is h8', grid[56].sq === 'h8', grid[56].sq);
  const topRow = grid.slice(0, 16);
  const bottomRow = grid.slice(48);
  check('white-user: user (White) army occupies the top two rows',
    topRow.every((c) => c.piece && c.piece[0] === 'w'),
    topRow.map((c) => c.piece).join(','));
  check('white-user: Stockfish (Black) army occupies the bottom two rows',
    bottomRow.every((c) => c.piece && c.piece[0] === 'b'),
    bottomRow.map((c) => c.piece).join(','));

  await page.screenshot({ path: `${OUT}/01-white-user.png` });

  // ---- click-to-move: e2 -> e4, then Stockfish answers ----
  await page.click('[data-square="e2"]');
  const highlighted = await page.$$eval('.square--target', (els) => els.map((e) => e.dataset.square));
  check('legal targets highlighted for e2', highlighted.sort().join(',') === 'e3,e4', highlighted.join(','));
  await page.screenshot({ path: `${OUT}/02-selected-e2.png` });

  await page.click('[data-square="e4"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-san').length >= 2, null, { timeout: 60000 });
  const afterFirst = await moves();
  check('user move recorded as e4', afterFirst[0] === 'e4', afterFirst.join(' '));
  check('Stockfish replied with a move', Boolean(afterFirst[1]), afterFirst.join(' '));
  check('back to player turn', /내 차례|체크!/.test(await banner()), await banner());
  const lastMoveSquares = await page.$$eval('.square--last', (els) => els.map((e) => e.dataset.square));
  check('last move highlighted', lastMoveSquares.length === 2, lastMoveSquares.join(','));

  // ---- drag-to-move: d2 -> d4 ----
  const box = async (sq) => (await page.$(`[data-square="${sq}"]`)).boundingBox();
  const from = await box('d2');
  const to = await box('d4');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 4 });
  await page.screenshot({ path: `${OUT}/03-dragging.png` });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-san').length >= 4, null, { timeout: 60000 });
  const afterDrag = await moves();
  check('drag produced d4', afterDrag[2] === 'd4', afterDrag.join(' '));

  // ---- input locked while the engine thinks ----
  const lockedDuringThink = await page.evaluate(async () => {
    const board = document.getElementById('board');
    return { locked: board.classList.contains('board--locked') };
  });
  check('board unlocked on player turn', lockedDuringThink.locked === false, JSON.stringify(lockedDuringThink));

  // ---- switch to Black: needs an explicit New Game, then Stockfish opens ----
  await page.click('button[data-side="b"]');
  const note = await page.$eval('#pending-note', (e) => ({ hidden: e.hidden, text: e.textContent.trim() }));
  check('side change mid-game shows pending note', note.hidden === false, note.text);

  await page.click('#new-game');
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-san').length === 1
       && document.getElementById('status-banner').textContent.includes('내 차례'),
    null, { timeout: 60000 });

  grid = await layout();
  check('black-user: top-left square is a8', grid[0].sq === 'a8', grid[0].sq);
  check('black-user: top-right square is h8', grid[7].sq === 'h8', grid[7].sq);
  const topRowB = grid.slice(0, 16);
  const bottomRowB = grid.slice(48);
  check('black-user: user (Black) army occupies the top two rows',
    topRowB.every((c) => c.piece && c.piece[0] === 'b'),
    topRowB.map((c) => c.piece).join(','));
  // Stockfish has already opened as White, so one of its home squares is empty.
  const bottomOccupied = bottomRowB.filter((c) => c.piece);
  check('black-user: Stockfish (White) army occupies the bottom two rows',
    bottomOccupied.length >= 15 && bottomOccupied.every((c) => c.piece[0] === 'w'),
    bottomRowB.map((c) => c.piece || '-').join(','));
  check('black-user: no White piece anywhere in the top two rows',
    topRowB.every((c) => !c.piece || c.piece[0] === 'b'));
  check('black-user: Stockfish moved first', (await moves()).length === 1, (await moves()).join(' '));
  check('tags swapped',
    (await page.$eval('#user-tag', (e) => e.textContent)).includes('흑')
    && (await page.$eval('#engine-tag', (e) => e.textContent)).includes('백'));
  check('move list reset to a single move', (await moves()).length === 1);

  await page.screenshot({ path: `${OUT}/04-black-user.png` });

  // user (Black) replies to confirm play works from the flipped side
  await page.click('[data-square="e7"]');
  await page.click('[data-square="e5"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-san').length >= 3, null, { timeout: 60000 });
  check('black user can move', (await moves())[1] === 'e5', (await moves()).join(' '));

  // ---- difficulty ----
  await page.click('button[data-difficulty="hard"]');
  check('difficulty switch reflected in UI',
    (await page.$eval('button[data-difficulty="hard"]', (e) => e.classList.contains('is-active'))));
  check('engine status mentions difficulty',
    /고급/.test(await page.$eval('#engine-value', (e) => e.textContent)),
    await page.$eval('#engine-value', (e) => e.textContent));

  // ---- exactly one worker across three games ----
  await page.click('#new-game');
  await page.waitForTimeout(1500);
  check('engine worker script fetched exactly once', engineScriptHits.length === 1,
    `${engineScriptHits.length} hit(s)`);

  // ---- board setup: build a back-rank mate position by hand ----
  await page.click('#setup-open');
  check('setup panel opens', await page.$eval('#setup', (e) => !e.hidden));
  check('game actions hidden during setup', await page.$eval('#game-actions', (e) => e.hidden));
  await page.click('button[data-side="w"]');
  check('side change during setup does not start a game',
    await page.$eval('#setup', (e) => !e.hidden) && /보드 세팅/.test(await banner()), await banner());

  check('setup previews the chosen side on top', (await layout())[0].sq === 'h1', (await layout())[0].sq);
  await page.click('#setup-clear');
  const place = async (tool, squares) => {
    await page.click(`#setup-palette [data-tool="${tool}"]`);
    for (const sq of squares) await page.click(`[data-square="${sq}"]`);
  };
  await place('wk', ['g1']);
  await place('wr', ['a1']);
  await place('wp', ['f2', 'g2', 'h2']);
  await place('bk', ['g8']);
  await place('bp', ['f7', 'g7', 'h7', 'a7']);
  await page.click('[data-square="a7"]', { button: 'right' });
  const setupFen = await page.$eval('#setup-fen', (e) => e.value);
  check('hand-built position produces the expected FEN',
    setupFen === '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', setupFen);
  check('start enabled for a legal position', await page.$eval('#setup-start', (e) => !e.disabled),
    await page.$eval('#setup-message', (e) => e.textContent));
  await page.screenshot({ path: `${OUT}/07-setup.png` });

  await page.click('#setup-start');
  await page.waitForFunction(
    () => document.getElementById('status-banner').textContent.includes('내 차례'), null, { timeout: 60000 });
  check('setup closes after start', await page.$eval('#setup', (e) => e.hidden));
  check('start value reports a custom position',
    (await page.$eval('#start-value', (e) => e.textContent)) === '사용자 지정');
  await page.click('[data-square="a1"]');
  await page.click('[data-square="a8"]');
  await page.waitForFunction(
    () => document.getElementById('result-value').textContent.includes('승리'), null, { timeout: 30000 });
  check('mate from the custom position is detected',
    /나의 승리/.test(await page.$eval('#result-value', (e) => e.textContent)),
    await page.$eval('#result-value', (e) => e.textContent));

  // ---- board setup: Stockfish to move in the custom position ----
  await page.click('#setup-open');
  await page.fill('#setup-fen', '4k3/8/8/8/8/8/4P3/4K2R b K - 0 1');
  await page.click('#setup-fen-load');
  await page.click('#setup-start');
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-san:not(.move-san--gap)').length === 1
       && document.getElementById('status-banner').textContent.includes('내 차례'),
    null, { timeout: 60000 });
  const blackFirst = await moves();
  check('Stockfish opens as Black from the custom position',
    blackFirst[0] === '…' && /^K/.test(blackFirst[1] ?? ''), blackFirst.join(' '));
  check('white can still castle in the custom position',
    await page.evaluate(() => { document.querySelector('[data-square="e1"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', pointerId: 9 })); return document.querySelector('[data-square="g1"]').classList.contains('square--target'); }));
  await page.screenshot({ path: `${OUT}/08-custom-game.png` });

  // ---- cancelling setup resumes the paused game ----
  const beforeCancel = await moves();
  await page.click('#setup-open');
  await page.click('#setup-clear');
  await page.click('#setup-cancel');
  check('cancel restores the game position',
    (await layout()).filter((c) => c.piece).length === 4 && (await moves()).join(' ') === beforeCancel.join(' '),
    (await moves()).join(' '));
  check('cancel returns to the player turn', /내 차례/.test(await banner()), await banner());

  // ---- mobile viewport ----
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobile.waitForFunction(
    () => document.getElementById('status-banner').textContent.includes('내 차례'),
    null, { timeout: 180000 });
  const overflow = await mobile.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    boardW: document.getElementById('board').getBoundingClientRect().width,
  }));
  check('no horizontal overflow on 390px viewport', overflow.docW <= overflow.winW + 1, JSON.stringify(overflow));
  await mobile.screenshot({ path: `${OUT}/05-mobile.png`, fullPage: true });
  await mobile.click('#setup-open');
  const setupOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('setup panel fits a 390px viewport', setupOverflow <= 1, `${setupOverflow}px`);
  await mobile.screenshot({ path: `${OUT}/09-mobile-setup.png`, fullPage: true });
  await mobile.close();

  check('no failed requests', failedRequests.length === 0, failedRequests.join(' | '));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
