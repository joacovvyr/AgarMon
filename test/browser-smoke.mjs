// Browser QA runs in GitHub Actions; npm test exercises the dependency-free backend.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createWebApp } from '../src/web-app.mjs';
const directory = mkdtempSync(join(tmpdir(), 'agarmon-browser-'));
const app = createWebApp({ dataDirectory:directory });
let browser;
try {
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(url);await page.waitForSelector('.room-card');
  await page.locator('#account-button').click();await page.locator('[data-auth="register"]').click();
  await page.getByLabel('Nombre',{exact:true}).fill('Cuenta de prueba');
  await page.getByLabel('Correo',{exact:true}).fill('browser-qa@example.com');
  await page.getByLabel('Contraseña',{exact:true}).fill('AgarMon-QA-test-2026');
  await page.locator('#auth-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#auth-dialog').open);
  await page.locator('#funds-button').click();
  await page.waitForFunction(()=>document.querySelector('#balance').textContent.includes('100,00'));
  await page.locator('.room-card').first().getByRole('button',{name:'Reservar entrada'}).click();
  await page.waitForFunction(()=>document.querySelector('#balance').textContent.includes('90,00'));
  await page.getByRole('button',{name:'Devolver mi reserva'}).click();
  await page.waitForFunction(()=>document.querySelector('#balance').textContent.includes('100,00'));
  await page.locator('#withdraw-button').click();
  await page.getByLabel('Monto en USD',{exact:true}).fill('10,00');
  await page.getByRole('button',{name:'Reservar retiro de prueba'}).click();await page.waitForSelector('.pending-row');
  await page.reload();await page.waitForSelector('.pending-row');
  await page.getByRole('button',{name:'Devolver saldo',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#balance').textContent.includes('100,00'));
  mkdirSync('test-output',{recursive:true});
  await page.screenshot({path:'test-output/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.goto(url);await page.waitForSelector('.room-card');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile_horizontal_overflow');
  await page.screenshot({path:'test-output/mobile.png',fullPage:true});
  await page.locator('[data-mode="hard"]').click();assert.equal(await page.locator('.room-card').count(),3);
  await page.locator('[data-mode="all"]').click();assert.equal(await page.locator('.room-card').count(),6);
  await page.locator('#account-button').click();
  await page.waitForFunction(()=>document.querySelector('#account-button').textContent.includes('Ingresar'));
  await page.locator('#account-button').click();
  await page.getByLabel('Correo',{exact:true}).fill('browser-qa@example.com');
  await page.getByLabel('Contraseña',{exact:true}).fill('AgarMon-QA-test-2026');
  // Auth mode persists from registration until explicitly selecting the login tab.
  await page.locator('[data-auth="login"]').click();await page.locator('#auth-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#auth-dialog').open);
  assert.deepEqual(errors,[]);
  console.log('Browser QA passed: registration, funding, entry/refund, withdrawal/reload/refund, filters, logout/login and mobile width.');
} finally {
  await browser?.close();await app.close();rmSync(directory,{recursive:true,force:true});
}
