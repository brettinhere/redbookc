const express  = require('express');
const bcrypt   = require('bcryptjs');
const { chromium } = require('playwright');

const app  = express();
app.use(express.json({ limit: '10mb' }));
const PORT = 8085;

const ANTI_BOT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  window.chrome = { runtime: {} };
`;

const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

// JS点击：滚动到元素并点击，不受 viewport 限制
async function jsClick(page, selector) {
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === sel)
            || document.querySelector(sel);
    if (el) { el.scrollIntoView(); el.click(); return true; }
    return false;
  }, selector);
}

async function clickByText(page, text, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((txt) => {
      const all = [...document.querySelectorAll('button, [role="button"], [class*="tab"], [class*="btn"], div, span')];
      const el = all.find(e => e.children.length === 0 && e.textContent.trim() === txt)
              || all.find(e => e.textContent.trim() === txt);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
      return false;
    }, text);
    if (found) return;
    await sleep(500);
  }
  throw new Error(`clickByText timeout: "${text}"`);
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'poster-server' }));

app.post('/bcrypt/hash', async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.body.password, 10);
    res.json({ ok: true, hash });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/bcrypt/verify', async (req, res) => {
  try {
    const ok = await bcrypt.compare(req.body.password, req.body.hash);
    res.json({ ok });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/post', async (req, res) => {
  const { profile_dir, content, account_id, image_path } = req.body;
  if (!profile_dir || !content) {
    return res.json({ ok: false, error: 'missing profile_dir or content' });
  }
  // image_path 可能是 URL 路径，转成本地文件系统路径
  let localImagePath = null;
  if (image_path && image_path.trim()) {
    if (image_path.startsWith('/redbookc/uploads/')) {
      localImagePath = '/opt/redBookC/uploads/' + image_path.replace('/redbookc/uploads/', '');
    } else if (image_path.startsWith('/opt/')) {
      localImagePath = image_path;
    }
    const fs = require('fs');
    if (localImagePath && !fs.existsSync(localImagePath)) {
      console.log('[Post] 图片文件不存在:', localImagePath, '，降级为文字配图');
      localImagePath = null;
    }
  }


  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(profile_dir, {
      headless: true,
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--lang=zh-CN'],
    });
    await browser.addInitScript(ANTI_BOT);
    const page = await browser.newPage();

    // 1. 进发布页
    await page.goto('https://creator.xiaohongshu.com/publish/publish', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(3000);

    if (page.url().includes('login')) {
      return res.json({ ok: false, error: 'cookie expired, need re-login' });
    }
    console.log('[Post] 发布页加载完成, URL:', page.url());

    // debug: 打印所有可见文字元素
    const visibleText = await page.evaluate(() => {
      return [...document.querySelectorAll('button, [class*="tab"], [class*="Tab"]')]
        .map(e => e.textContent.trim()).filter(t => t).join(' | ');
    });
    console.log('[Post] 页面元素:', visibleText.substring(0, 200));

    // 2. 点"上传图文" — 用 JS 点击
    await clickByText(page, '上传图文');
    await sleep(4000);
    console.log('[Post] 已切换到上传图文');

    if (localImagePath) {
      // ── 有图片：上传自定义图片 ──────────────────────────────
      console.log('[Post] 有图片，走上传图片流程:', localImagePath);

      // 直接用 JS 找到 file input 并 setInputFiles，不依赖 waitForSelector
      let fileInput = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        fileInput = await page.$('input.upload-input, input[type="file"][accept*="jpg"], input[accept*="jpg"]');
        if (fileInput) break;
        console.log('[Post] 等待 file input, attempt', attempt+1);
        await sleep(1000);
      }
      if (!fileInput) {
        // 最后手段：用 page.locator
        try {
          await page.locator('input[type="file"]').first().setInputFiles(localImagePath);
          console.log('[Post] 用 locator 上传图片');
        } catch(e) {
          throw new Error('找不到 file input: ' + e.message);
        }
      } else {
        await fileInput.setInputFiles(localImagePath);
        console.log('[Post] 图片 setInputFiles 成功');
      }
      console.log('[Post] 图片上传中...');
      await sleep(6000);

      // 等图片上传完成（等待上传进度消失）

      // 图片上传后页面直接进入编辑页（无"下一步"），直接填写正文
      console.log('[Post] 图片上传完成，填写正文');

      // 填写正文：优先 ProseMirror，其次 textarea
      let contentFilled = false;
      try {
        await page.waitForSelector('.ProseMirror', { timeout: 8000 });
        await page.evaluate((text) => {
          const el = document.querySelector('.ProseMirror');
          if (!el) return;
          el.focus();
          document.execCommand('selectAll');
          document.execCommand('insertText', false, text);
        }, content);
        console.log('[Post] 正文已填写 (ProseMirror)');
        contentFilled = true;
      } catch(_) {}
      if (!contentFilled) {
        try {
          const descEl = await page.waitForSelector(
            'textarea[placeholder*="描述"], textarea[placeholder*="正文"]', { timeout: 5000 }
          );
          await descEl.fill(content);
          console.log('[Post] 正文已填写 (textarea)');
        } catch(_) { console.log('[Post] 无正文框，跳过'); }
      }
      await sleep(1500);

    } else {
      // ── 无图片：文字配图流程 ────────────────────────────────
      console.log('[Post] 无图片，走文字配图流程');

      // 3. 点"文字配图"
      await clickByText(page, '文字配图');
      await sleep(2500);
      console.log('[Post] 进入文字配图');

      // 4. 等 ProseMirror
      await page.waitForSelector('.ProseMirror', { timeout: 10000 });
      console.log('[Post] 编辑器已出现');

      // 5. 输入内容
      await page.evaluate((text) => {
        const el = document.querySelector('.ProseMirror');
        if (!el) return;
        el.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
      }, content);
      await sleep(1500);
      console.log('[Post] 内容输入完成');

      // 6. 点"生成图片"
      await clickByText(page, '生成图片');
      console.log('[Post] 生成图片中...');
      await sleep(8000);

  
      // 7. 点"下一步"
      await clickByText(page, '下一步');
      console.log('[Post] 已点击下一步');
      await sleep(4000);
    }


    // 8. 填标题
    try {
      const titleInput = await page.waitForSelector(
        'input[placeholder*="标题"], input[class*="title"]', { timeout: 5000 }
      );
      const title = content.split('\n')[0].replace(/[#*【】⚡🔥💡✨]/g, '').trim().substring(0, 20);
      await page.evaluate((el, t) => {
        el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
      }, titleInput, title);
      await sleep(500);
      console.log('[Post] 标题:', title);
    } catch (_) {
      console.log('[Post] 无标题框');
    }

    // 9. 发布
    await clickByText(page, '发布');
    console.log('[Post] 已点击发布');
    await sleep(7000);

    const afterUrl = page.url();
    console.log('[Post] 完成, URL:', afterUrl);
    return res.json({ ok: true, url: afterUrl, account_id });

  } catch (err) {
    const msg = err.message.split('\n')[0];
    console.error('[Post] 错误:', msg);
    return res.json({ ok: false, error: msg });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`[poster-server] port=${PORT}`));
