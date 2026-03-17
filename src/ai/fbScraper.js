/**
 * fbScraper.js — Thin Re-export (Legacy Compatibility)
 * 
 * All scraping logic has been modularized into src/scraper/:
 *   browserManager.js  — Browser state, session I/O, TOTP, proxies
 *   authContext.js      — Facebook login + session validation
 *   groupScraper.js     — getGroupPosts() + inner scraping
 *   commentScraper.js   — getPostComments()
 *   groupJoiner.js      — autoJoinGroups()
 *   orchestrator.js     — scrapeFacebookGroups() + _scrapeWithContext()
 *   hubBridge.js        — bridgeToHub()
 *   index.js            — Facade re-exporting all modules
 * 
 * This file exists ONLY for backward compatibility.
 * Any code that does require('./fbScraper') will get the same API.
 */
module.exports = require('../scraper');
