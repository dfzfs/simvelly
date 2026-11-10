/*
 * Larkhaven (심밸리) — SillyTavern extension build.
 * The game code below this header is the Tavern Helper script, unchanged. This header only maps the few
 * Tavern Helper functions that script uses onto SillyTavern's own extension API, and installs the two
 * regex scripts the game needs. No network requests, no eval.
 */
(() => {
  'use strict';
  if (window.__larkhavenExtensionLoaded) return;
  window.__larkhavenExtensionLoaded = true;

  const ctx = () => SillyTavern.getContext();
  const tavern_events = ctx().event_types || ctx().eventTypes || {};
  const eventOn = (ev, fn) => { if (ev) ctx().eventSource.on(ev, fn); };

  // chat messages in the shape the game expects: [{ message_id, role, message }]
  const roleOf = (m) => (m.is_user ? 'user' : m.is_system ? 'system' : 'assistant');
  const getChatMessages = async (range) => {
    const chat = ctx().chat || [];
    const all = chat.map((m, i) => ({ message_id: i, role: roleOf(m), message: typeof m.mes === 'string' ? m.mes : '' }));
    return typeof range === 'number' ? all.slice(range, range + 1) : all;
  };
  // write a message's text (current swipe included), redraw it and save the chat
  const setChatMessages = async (list) => {
    const c = ctx();
    for (const it of list) {
      const m = c.chat && c.chat[it.message_id];
      if (!m) continue;
      m.mes = it.message;
      if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipes[m.swipe_id] !== undefined) m.swipes[m.swipe_id] = it.message;
      try { if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(it.message_id, m); } catch (e) { console.warn('[Larkhaven] could not redraw the message', e); }
    }
    try { const save = c.saveChat || c.saveChatConditional; if (typeof save === 'function') await save(); } catch (e) { console.warn('[Larkhaven] could not save the chat', e); }
  };

  // per-chat storage: the chat's own variables, saved with the chat file
  const store = () => {
    const c = ctx();
    if (!c.chatMetadata) return {};
    if (!c.chatMetadata.variables || typeof c.chatMetadata.variables !== 'object') c.chatMetadata.variables = {};
    return c.chatMetadata.variables;
  };
  const getVariables = () => JSON.parse(JSON.stringify(store()));
  const updateVariablesWith = async (fn) => {
    const c = ctx();
    const next = fn(JSON.parse(JSON.stringify(store())));
    if (next && typeof next === 'object' && c.chatMetadata) c.chatMetadata.variables = next;
    const save = c.saveMetadataDebounced || c.saveMetadata;
    if (typeof save === 'function') await save();
  };

  // prompt injection: in-chat extension prompts (position 1 = in chat; role 0 system, 1 user, 2 assistant)
  const injectPrompts = (list) => {
    const c = ctx();
    for (const p of list) c.setExtensionPrompt(p.id, String(p.content || ''), 1, p.depth || 0, !!p.should_scan, p.role === 'user' ? 1 : p.role === 'assistant' ? 2 : 0);
  };
  const uninjectPrompts = (ids) => {
    const c = ctx();
    for (const id of ids) c.setExtensionPrompt(id, '', 1, 0, false, 0);
  };

  // the two regex scripts (hide <delta> on screen, trim old <delta> blocks from the prompt), added once
  const REGEX = [
    {
      "id": "c66fa332-5417-4d9e-90e0-47cedf4aed65",
      "scriptName": "Larkhaven - hide delta",
      "findRegex": "/<delta>[\\s\\S]*?(?:<\\/delta>|$)/g",
      "replaceString": "",
      "trimStrings": [],
      "placement": [
        2
      ],
      "disabled": false,
      "markdownOnly": true,
      "promptOnly": false,
      "runOnEdit": true,
      "substituteRegex": 0,
      "minDepth": null,
      "maxDepth": null
    },
    {
      "id": "0a85f2b5-6154-4ab8-b800-49939191d8b7",
      "scriptName": "Larkhaven - trim old deltas from prompt",
      "findRegex": "/\\n*<delta>[\\s\\S]*?<\\/delta>/g",
      "replaceString": "",
      "trimStrings": [],
      "placement": [
        2
      ],
      "disabled": false,
      "markdownOnly": false,
      "promptOnly": true,
      "runOnEdit": true,
      "substituteRegex": 0,
      "minDepth": 6,
      "maxDepth": null
    }
  ];
  const ensureRegex = () => {
    try {
      const c = ctx();
      const es = c.extensionSettings;
      if (!es) return;
      if (!Array.isArray(es.regex)) es.regex = [];
      let added = false;
      for (const r of REGEX) if (!es.regex.some((x) => x && (x.id === r.id || x.scriptName === r.scriptName))) { es.regex.push({ ...r }); added = true; }
      if (added && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    } catch (e) { console.warn('[Larkhaven] could not add the regex scripts; import them by hand', e); }
  };
  ensureRegex();
  if (tavern_events.APP_READY) eventOn(tavern_events.APP_READY, ensureRegex);

/* ============================ GAME CODE (unchanged Tavern Helper script) ============================ */
/*
 * Larkhaven v3.0 — Tavern Helper script (slow-burn romance life-sim: engine + status UI)
 * The narrator ends each reply with a <delta> block; this script replays every delta in the chat
 * (swipe/edit safe, with a checkpoint so old messages can be deleted or hidden), applies the rules,
 * injects a compact <state> before each generation and draws the status bar, the panels and the
 * create-a-resident screen.
 * v3.0: memories per townsperson (memo.<npc>), private thoughts (thought.<npc>), time skips (days: +N),
 *       a leaner <state>, daily town news, a forgiving delta parser, and it stays silent in other chats.
 * v3.1: the person the player is with follows them off-schedule (scene), a tiny scan line loads the right
 *       lorebook entries, optional one-person route focus (flag: route=<npc>), quieter optional hooks.
 * Safety: no network requests, no eval/Function, no stored secrets, all text rendered with textContent.
 */

/* ============================== ENGINE ============================== */

const LH = (() => {
  const VERSION = 1;
  const SLOTS = ['Morning', 'Afternoon', 'Evening', 'Night'];
  const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DISTRICTS = ['downtown', 'meadow', 'harbor', 'makers_row', 'hilltop'];
  const WEATHER = ['clear', 'rain', 'wind', 'snow'];
  const TRAITS = ['green_thumb', 'anglers_luck', 'foodie', 'handy', 'charmer', 'creative_soul', 'homebody', 'night_owl'];
  // difficulty multiplier, romanceable, birthday [season index, day], side ('store', 'market' or null)
  const NPC_DATA = {
    damon:   { name: 'Damon Ashcroft', diff: 0.7, romance: true,  bday: [3, 3],  side: 'store' },
    julius:  { name: 'Julius Rourke',  diff: 0.7,  romance: true,  bday: [2, 19], side: 'store' },
    callum:  { name: 'Callum Hayes',   diff: 1.0,  romance: true,  bday: [0, 18], side: null },
    celeste: { name: 'Celeste Rourke', diff: 0.7, romance: true,  bday: [1, 10], side: 'store' },
    fabian:  { name: 'Fabian Marlowe', diff: 1.0,  romance: true,  bday: [2, 11], side: 'market' },
    holden:  { name: 'Holden Sakaki',  diff: 0.7, romance: true,  bday: [3, 19], side: 'market' },
    garrett: { name: 'Garrett Mercer', diff: 1.0,  romance: true,  bday: [1, 25], side: null },
    rowan:   { name: 'Rowan Hale',     diff: 1.25,  romance: true,  bday: [0, 3],  side: null },
    sasha:   { name: 'Sasha Quinn',    diff: 1.0,  romance: true,  bday: [2, 4],  side: null },
    jett:    { name: 'Jett Quinn',     diff: 0.7, romance: true,  bday: [3, 12], side: null },
    vesper:  { name: 'Vesper Thorne',  diff: 1.0,  romance: true,  bday: [0, 21], side: null },
    howard:  { name: 'Howard Finch',   diff: 1.25,  romance: false, bday: [2, 2],  side: 'market' },
    mabel:   { name: 'Mabel Finch',    diff: 1.25,  romance: false, bday: [0, 10], side: 'market' },
    nell:    { name: 'Nell Bramble',   diff: 1.25,  romance: false, bday: [1, 17], side: null },
    maggie:  { name: 'Maggie Lin',     diff: 1.0,  romance: false, bday: [3, 22], side: 'store' },
    pip:     { name: 'Pip Doyle',      diff: 1.25,  romance: false, bday: [0, 26], side: null },
    gus:     { name: 'Gus Harlow',     diff: 1.0,  romance: false, bday: [1, 3],  side: null },
    ada:     { name: 'Ada Moreau',     diff: 1.0,  romance: false, bday: [2, 24], side: null },
    bea:     { name: 'Bea Larkin',     diff: 1.25,  romance: false, bday: [0, 9],  side: 'market' },
  };
  const NPCS = Object.keys(NPC_DATA);
  const BASE_NPCS = NPCS.slice();
  let CUSTOM = {}; // townspeople the player added: id -> {role, romance}
  let NOTES = {};  // id -> the player's own sheet (custom people) or extra canon (original people)
  const DEFAULT_SPOT = { downtown: 'town_square', meadow: 'orchard', harbor: 'pier', makers_row: 'old_mill_market', hilltop: 'sunflower_field' };
  // Register the player's custom townspeople and notes. Call before replay; safe to call again with a new list.
  function setCustom(list) {
    for (const id of Object.keys(CUSTOM)) { delete NPC_DATA[id]; delete SCHED_PARSED[id]; delete KO_NAME[id]; delete ROLE[id]; }
    NPCS.length = BASE_NPCS.length;
    CUSTOM = {}; NOTES = {};
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c.id !== 'string') continue;
      const id = c.id.trim().toLowerCase();
      const text = cleanText(c.profile || '', 1200);
      if (BASE_NPCS.includes(id)) { if (text) NOTES[id] = text; continue; }
      if (!/^[a-z]{2,14}$/.test(id) || NPC_DATA[id] || NPCS.length >= BASE_NPCS.length + 12) continue;
      const name = cleanText(c.name || id, 40) || id;
      const d = DISTRICTS.includes(c.district) ? c.district : 'downtown';
      const spot = /^[a-z0-9_]{2,30}$/.test(c.spot || '') ? c.spot : DEFAULT_SPOT[d];
      const slots = [...new Set(String(c.slots || 'MAE').toUpperCase())].filter((ch) => 'MAEN'.includes(ch)).map((ch) => 'MAEN'.indexOf(ch));
      const role = cleanText(c.role || '', 60) || 'a townsperson';
      NPC_DATA[id] = { name, diff: [0.7, 1.0, 1.25].includes(c.diff) ? c.diff : 1.0, romance: !!c.romance, bday: [-1, 0], side: c.side === 'store' || c.side === 'market' ? c.side : null, custom: true };
      NPCS.push(id);
      SCHED_PARSED[id] = [{ days: [0, 1, 2, 3, 4, 5, 6], slots: slots.length ? slots : [0, 1, 2], place: `${d}/${spot}` }];
      KO_NAME[id] = name;
      ROLE[id] = [role, role];
      CUSTOM[id] = { role, romance: !!c.romance };
      if (text) NOTES[id] = text;
    }
  }
  const TIERS = [
    { min: 85, name: 'Best Friend' }, { min: 65, name: 'Close Friend' }, { min: 45, name: 'Friend' },
    { min: 25, name: 'Friendly' }, { min: 10, name: 'Acquaintance' }, { min: 0, name: 'Stranger' },
  ];
  const EVENT_AT = [25, 45, 65, 85];
  const TALK_BASE = { small: 2, shared: 4, help: 5, topic: 1 };
  const GIFT_BASE = { loved: 8, liked: 4, neutral: 1, disliked: -3, hated: -8 };
  const ROMANCE_STEPS = ['none', 'interested', 'dating', 'partnered', 'engaged', 'married'];

  // ---- home (M5): id -> [type, price, comfort, style]
  // id -> [slot type, price, comfort, style, theme]; three placed pieces of one theme make a set
  const FURNITURE = {
    worn_sofa: ['living', 0, 6, 1, ''],
    linen_sofa: ['living', 320, 14, 8, 'modern'],
    armchair: ['living', 180, 9, 5, 'cottage'],
    woven_rug: ['decor', 90, 3, 6, 'artisan'],
    floor_lamp: ['decor', 70, 2, 4, 'modern'],
    houseplant: ['decor', 35, 1, 4, 'hill'],
    framed_print: ['decor', 80, 0, 7, 'modern'],
    record_player: ['decor', 190, 3, 9, 'artisan'],
    quilt: ['decor', 120, 6, 5, 'cottage'],
    farmhouse_table: ['kitchen', 240, 4, 7, 'cottage'],
    pantry_shelf: ['kitchen', 150, 0, 3, 'cottage'],
    single_bed: ['bedroom', 0, 8, 1, ''],
    double_bed: ['bedroom', 450, 20, 8, 'modern'],
    nightstand_lamp: ['bedroom', 60, 2, 3, 'modern'],
    writing_desk: ['study', 200, 3, 6, 'artisan'],
    bookshelf: ['study', 160, 2, 7, 'artisan'],
    easel: ['study', 140, 0, 5, 'artisan'],
    workbench: ['study', 260, 0, 4, 'artisan'],
    porch_swing: ['porch', 210, 10, 6, 'cottage'],
    herb_planter: ['porch', 55, 1, 5, 'hill'],
    velvet_sofa: ['living', 680, 18, 14, 'modern'],
    glass_coffee_table: ['living', 260, 2, 9, 'modern'],
    marble_island: ['kitchen', 520, 3, 12, 'modern'],
    espresso_machine: ['kitchen', 340, 4, 8, 'modern'],
    canopy_bed: ['bedroom', 900, 26, 15, 'modern'],
    vanity_mirror: ['bedroom', 280, 2, 10, 'modern'],
    crystal_lamp: ['decor', 230, 2, 11, 'modern'],
    neon_sign: ['decor', 150, 0, 9, 'modern'],
    rocking_chair: ['living', 160, 10, 5, 'cottage'],
    gingham_curtains: ['decor', 60, 2, 5, 'cottage'],
    cast_iron_stove: ['kitchen', 300, 6, 8, 'cottage'],
    patchwork_bed: ['bedroom', 380, 18, 9, 'cottage'],
    flower_box: ['porch', 45, 1, 5, 'cottage'],
    net_hammock: ['porch', 180, 12, 6, 'harbor'],
    ship_lantern: ['decor', 85, 1, 7, 'harbor'],
    driftwood_table: ['living', 220, 3, 9, 'harbor'],
    captain_chest: ['bedroom', 240, 2, 9, 'harbor'],
    cat_tower: ['decor', 110, 4, 5, 'harbor'],
    shell_chimes: ['porch', 50, 0, 6, 'harbor'],
    sakaki_tea_set: ['kitchen', 190, 2, 11, 'artisan'],
    loom_tapestry: ['decor', 210, 1, 12, 'artisan'],
    pottery_shelf: ['study', 230, 1, 10, 'artisan'],
    kintsugi_vase: ['decor', 160, 0, 10, 'artisan'],
    magic_poster: ['decor', 40, 0, 4, 'artisan'],
    sunflower_vase: ['decor', 30, 1, 5, 'hill'],
    moon_lamp: ['bedroom', 140, 3, 9, 'hill'],
    rabbit_cushion: ['living', 55, 5, 4, 'hill'],
    star_mobile: ['decor', 95, 1, 8, 'hill'],
    perfume_cabinet: ['study', 320, 0, 12, 'hill'],
    windmill_model: ['study', 120, 0, 7, 'hill'],
  };
  const THEMES = ['modern', 'cottage', 'harbor', 'artisan', 'hill'];
  const SHOW_CAP = [0, 3, 5, 7, 10]; // keepsakes on display, by house level

  const HOUSE = [null,
    { name: 'Starter Home', slots: 8, price: 0 }, { name: 'Extended Home', slots: 14, price: 2500 },
    { name: 'Family House', slots: 20, price: 7500 }, { name: 'Dream House', slots: 28, price: 18000 },
  ];
  const BASE_SLOTS = { living: 2, kitchen: 1, bedroom: 1, study: 1, porch: 1, decor: 2 };
  // collectibles by district; at most one find per district per day
  const COLLECT = {
    downtown: ['spring_ribbon', 'rooftop_coaster', 'black_rose_brooch', 'brothers_photo', 'window_star', 'perfume_sample', 'elevator_token', 'gold_sale_tag', 'display_snowglobe', 'founders_pin'],
    makers_row: ['potter_stamp', 'weaver_stamp', 'magician_stamp', 'florist_stamp', 'tea_stamp', 'mill_wheel_stamp', 'kintsugi_stamp', 'market_bell_stamp', 'chalk_art_stamp', 'centennial_stamp'],
    meadow: ['old_sneaker', 'shiny_stone', 'dog_tag', 'little_farmer_sticker', 'golden_apple', 'lost_glove', 'wooden_duck', 'horseshoe', 'old_seed_packet', 'love_letter_scrap'],
    harbor: ['cat_captain', 'cat_marmalade', 'cat_pepper', 'cat_shadow', 'cat_biscuit', 'cat_sardine', 'cat_admiral', 'cat_mochi', 'cat_ink', 'cat_tofu'],
    hilltop: ['four_leaf_clover', 'sunflower_seed', 'strange_bottle', 'promise_letter_piece', 'moon_pebble', 'white_feather', 'old_bell', 'dried_lavender', 'star_candy', 'lantern_wick'],
  };
  const COLLECT_ALL_COUNT = Object.values(COLLECT).reduce((a, b) => a + b.length, 0);
  const COLLECT_DISTRICT = Object.fromEntries(Object.entries(COLLECT).flatMap(([d, ids]) => ids.map((id) => [id, d])));

  const skillNeed = (L) => 50 * (L + 1); // XP from level L to L+1
  const PERKS = {
    gardening: ['fertile_hands', 'rain_whisperer'], cooking: ['home_chef', 'market_cook'],
    fishing: ['patient_angler', 'deep_water'], crafting: ['master_hands', 'repair_eye'],
    charisma: ['warm_presence', 'networker'], art: ['gallery_eye', 'muse'],
  };
  const TRAIT_SKILL = {
    green_thumb: 'gardening', anglers_luck: 'fishing', foodie: 'cooking',
    handy: 'crafting', charmer: 'charisma', creative_soul: 'art',
  };
  const MOOD_XP = { Great: 1.25, Good: 1.0, Low: 0.75, Stressed: 0.5 };
  const CAREER_XP = [0, 0, 100, 250, 450, 700];      // total career XP to reach level L
  const CAREER_SKILL_GATE = [0, 0, 2, 4, 6, 8];       // linked skill level to reach level L
  const CAREER_MENTOR_GATE = [0, 0, 0, 0, 45, 65];    // mentor affinity to reach level L
  const CAREER_PAY = [0, 40, 60, 85, 115, 150];
  const CAREER = {
    store:    { mentor: 'damon',  skills: ['charisma'],         side: 'store',  days: [0, 1, 2, 3, 4, 5], titles: ['Stock Clerk', 'Sales Associate', 'Floor Lead', 'Department Manager', 'Store Director'] },
    cafe:     { mentor: 'sasha',  skills: ['cooking'],          side: null,     days: [0, 1, 2, 3, 4, 5], titles: ['Dishwasher', 'Line Cook', 'Sous Chef', 'Head Chef', 'Partner Chef'] },
    farm:     { mentor: 'rowan',  skills: ['gardening'],        side: null,     days: [0, 1, 2, 3, 4, 5], titles: ['Farmhand', 'Grower', 'Market Gardener', 'Orchard Lead', 'Farm Partner'] },
    harbor:   { mentor: 'gus',    skills: ['fishing'],          side: null,     days: [0, 1, 2, 3, 4, 5], titles: ['Deckhand', 'Angler', 'Boat Mate', 'Fish Merchant', 'Harbormaster'] },
    makers:   { mentor: 'holden', skills: ['crafting', 'art'],  side: 'market', days: [0, 1, 2, 3, 4, 5], titles: ['Apprentice', 'Artisan', 'Stallholder', 'Exhibiting Maker', 'Studio Master'] },
    freelance:{ mentor: null,     skills: [],                   side: null,     days: [0, 1, 2, 3, 4, 5, 6], titles: ['Freelancer'] },
  };
  const SKILLS = ['gardening', 'cooking', 'fishing', 'crafting', 'charisma', 'art'];
  const TRACKS = ['store', 'cafe', 'farm', 'harbor', 'makers', 'freelance'];
  // Five rentable homes, one per district; the player picks one at the start (key "home").
  const HOMES = {
    meadow: { spot: 'wren_cottage', name: 'Wren Cottage', ko: '렌 코티지' },
    downtown: { spot: 'glass_loft', name: 'Glasshouse Loft', ko: '글라스하우스 로프트' },
    makers_row: { spot: 'mill_garret', name: 'Mill Garret', ko: '방앗간 다락방' },
    harbor: { spot: 'gull_house', name: 'Gull House', ko: '갈매기 집' },
    hilltop: { spot: 'windrow_cottage', name: 'Windrow Cottage', ko: '윈드로 코티지' },
  };
  const homeDistrict = (s) => (HOMES[s.player.home] ? s.player.home : 'meadow');
  const homePlace = (s) => `${homeDistrict(s)}/${HOMES[homeDistrict(s)].spot}`;

  // season index - day : festival name (Design & Rules, Calendar)
  const FESTIVALS = {
    '0-7': 'Love Day', '0-13': 'Egg Hunt', '0-24': 'Spring Dance', '0-28': 'Spring Market Day',
    '1-6': 'Beach Party', '1-14': 'Cat Festival', '1-21': 'Fireworks Night', '1-28': 'Moonlight Jellies',
    '2-8': 'Sunflower Festival', '2-16': 'Harvest Fair', '2-22': 'Thanksgiving Supper', '2-27': 'Halloween Night',
    '3-8': 'Ice Festival', '3-15': 'Winter Market', '3-25': 'Winter Star', '3-28': 'New Year Countdown',
  };

  const FEST_DESC = {
    'Love Day': 'town square, flowers and anonymous notes; Bea\'s busiest day',
    'Egg Hunt': 'meadow fairground; Butter hides the eggs',
    'Spring Dance': 'Lantern Hill sunflower field; ask a partner, Friend 45+ accepts, each refuses in their own way',
    'Spring Market Day': 'Old Mill Market fair vs Ashcroft\'s rival sale; where the player goes is noticed; crafts and art x1.5',
    'Beach Party': 'harbor beach, one shared pot led by Sasha; each guest\'s ingredient changes the dish',
    'Cat Festival': 'pier cat beauty contest; Captain\'s crowning',
    'Fireworks Night': 'Ashcroft\'s rooftop terrace; Fabian and Garrett drink at the lighthouse instead',
    'Moonlight Jellies': 'lighthouse, glowing jellyfish, best watched as two',
    'Sunflower Festival': 'Lantern Hill, photos under the windmill, white rabbits',
    'Harvest Fair': 'meadow fairground, market vs store judging, the feud\'s yearly peak, top prize $400',
    'Thanksgiving Supper': 'Finch teahouse, both sides at one awkward table',
    'Halloween Night': 'Lantern Hill maze and costumes; strange things around Vesper',
    'Ice Festival': 'meadow pond, skating, ice fishing, snowman contest',
    'Winter Market': 'Old Mill gift market vs Ashcroft\'s holiday window; crafts and art x1.5',
    'Winter Star': 'town square, secret gift exchange with a random partner',
    'New Year Countdown': 'windmill, a kiss at midnight with whoever is beside you',
  };

  const RULES = Object.freeze({
    rent: 120,
    evictionOwed: 360,
    decay: { energy: 8, hunger: 8, social: 5, socialHomebody: 2 },
    hungerZeroEnergyPenalty: 10,
    passOutEnergy: 30,
    maxSlotsPerDelta: 4,
    ledgerSize: 50,
    dailyAffinityCap: 8,
    firstMeetBonus: 2,
    decayDays: 7,
    decayAmount: 2,
    heartEventBonus: 5,
    breakupCost: 20,
    partnerDays: 14,
    marriageDays: 14,
    politicsGap: 5,
    overnightEnergyHome: 80,
    overnightEnergyAway: 50,
    overnightHunger: 60,
    ckptLag: 20,
    seekGap: 2,
    memoKeep: 6,
    storyMemoKeep: 6,
    memoLen: 160,
    maxSkipDays: 14,
    sideGain: 3,
    sideLoss: 2,
    leanMax: 5,
    leanSide: 3,
  });

  // Keys parsed now but applied in later milestones.
  const DEFERRED = /^$^/; // nothing is deferred any more

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const roundHalfUp = (x) => Math.floor(x + 0.5);

  const emptyToday = () => ({ skills: [], careers: [], districts: [], talks: [], gifts: [], met: [], income: 0, collected: [] });

  function baseState() {
    const npc = {};
    for (const id of NPCS) {
      npc[id] = { lastContact: null, lastDecay: null, todayGain: 0, giftedToday: false, helpedToday: false, talked: false, met: false, events: [], romance: 'none', romanceSince: null, metDay: null, memos: [], thought: '' };
    }
    const skills = {};
    for (const id of SKILLS) skills[id] = { level: 1, xp: 0 };
    const tracks = {};
    for (const id of TRACKS) tracks[id] = { xp: 0, level: 1 };
    return {
      v: VERSION,
      player: { name: '', traits: [], created: false, pronouns: '', look: '', backstory: '', personality: '', details: '', home: 'meadow' },
      time: { year: 1, season: 0, day: 1, slot: 0 },
      weather: 'clear',
      place: { district: 'meadow', spot: 'wren_cottage' },
      money: 1200,
      needs: { energy: 100, hunger: 70, social: 60 },
      skills,
      perks: {},
      pendingPerks: [],
      career: { current: null, tracks },
      affinity: Object.fromEntries(NPCS.map((id) => [id, 0])),
      npc,
      inventory: { worn_sofa: 1, single_bed: 1 },
      home: { level: 1, placed: ['worn_sofa', 'single_bed'], pending: null, shown: [] },
      achievements: [],
      flags: [],
      rent: { owed: 0, streak: 0 },
      stats: { homeNightStreak: 0, shifts: 0, lastPolitics: null },
      lean: 0,
      collection: [],
      memos: [],
      ledger: [],
      scene: [],
      today: emptyToday(),
    };
  }

  function freshState() {
    return baseState();
  }
  // Fill fields that a checkpoint saved by an older version does not have.
  function normalize(s) {
    const b = baseState();
    for (const k of Object.keys(b)) if (!(k in s)) s[k] = b[k];
    for (const k of Object.keys(b.player)) if (!(k in s.player)) s.player[k] = b.player[k];
    for (const id of NPCS) {
      if (!s.npc[id]) s.npc[id] = b.npc[id];
      for (const k of Object.keys(b.npc[id])) if (!(k in s.npc[id])) s.npc[id][k] = b.npc[id][k];
      if (!(id in s.affinity)) s.affinity[id] = 0;
    }
    if (!Array.isArray(s.home.shown)) s.home.shown = [];
    // a custom townsperson may have been removed since this state was saved
    const known = (id) => !!NPC_DATA[id];
    s.scene = (s.scene || []).filter(known);
    s.today.talks = (s.today.talks || []).filter(known);
    s.today.met = (s.today.met || []).filter(known);
    s.today.gifts = (s.today.gifts || []).filter((g) => g && known(g.id));
    return s;
  }
  const initialState = freshState;

  /* ---------- derived values ---------- */

  const dayIndex = (t) => (t.year - 1) * 112 + t.season * 28 + (t.day - 1);
  const weekday = (t) => dayIndex(t) % 7; // 0 = Monday
  const festivalOf = (t) => FESTIVALS[`${t.season}-${t.day}`] || null;

  function moodOf(needs) {
    const avg = roundHalfUp((needs.energy + needs.hunger + needs.social) / 3);
    if (avg >= 75) return 'Great';
    if (avg >= 50) return 'Good';
    if (avg >= 25) return 'Low';
    return 'Stressed';
  }

  const dateLabel = (t) => `${SEASONS[t.season]} ${t.day} (${WEEKDAYS[weekday(t)]}), Year ${t.year}`;

  /* ---------- parsing ---------- */

  // Returns the inner text of the LAST <delta>…</delta> block, or null.
  function extractDelta(text) {
    if (typeof text !== 'string') return null;
    const re = /<delta>([\s\S]*?)<\/delta>/gi;
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    if (last === null) { // a reply cut off before </delta> still counts
      const open = text.match(/<delta>([\s\S]*)$/i);
      if (open) last = open[1];
    }
    return last;
  }

  // Forgiving aliases for keys the narrator sometimes invents.
  const ALIASES = {
    'player.name': 'name', 'player_name': 'name', 'character.name': 'name', 'char.name': 'name', 'user.name': 'name',
    'player.trait': 'trait', 'player.traits': 'trait', 'traits': 'trait',
    'player.pronouns': 'pronouns', 'player.personality': 'personality', 'player.details': 'details', 'detail': 'details', 'player.look': 'look', 'appearance': 'look', 'player.backstory': 'backstory', 'backstory.why': 'backstory',
    'slots': 'time', 'slot': 'time', 'time.slots': 'time', 'time.advance': 'time', 'time.add': 'time',
    'player.money': 'money', 'gold': 'money', 'cash': 'money',
    'location': 'place', 'player.place': 'place',
    'skip': 'days', 'day': 'days', 'time.days': 'days', 'timeskip': 'days',
    'note': 'memo', 'memory': 'memo', 'remember': 'memo',
  };
  const PREFIX_ALIASES = { 'note.': 'memo.', 'memory.': 'memo.', 'remember.': 'memo.', 'thoughts.': 'thought.', 'heart.': 'thought.', 'inner.': 'thought.' };

  // "key: value" per line → [{key, value, line}]
  function parseDelta(inner) {
    const out = [];
    const warnings = [];
    for (const raw of inner.split(/\r?\n/)) {
      const line = raw.trim().replace(/^[-*•>\s]+/, '').replace(/^`+|`+$/g, '').trim(); // forgive bullets and code ticks
      if (!line || /^(```|delta)$/i.test(line)) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*[:=]\s*(.+)$/);
      if (!m) { warnings.push(`unreadable line: "${line}"`); continue; }
      let k = m[1].toLowerCase();
      for (const pre of Object.keys(PREFIX_ALIASES)) if (k.startsWith(pre)) k = PREFIX_ALIASES[pre] + k.slice(pre.length);
      out.push({ key: ALIASES[k] || k, value: m[2].trim(), line });
    }
    return { lines: out, warnings };
  }

  // "+N", "-N" or bare "N" → signed integer; null if invalid.
  function relNum(v) {
    const m = String(v).replace(/[$,\s]/g, '').match(/^([+-]?)(\d+)$/);
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
  }

  /* ---------- engine steps ---------- */

  function addLedger(s, amount, reason) {
    s.money += amount;
    s.ledger.push({ date: dateLabel(s.time), slot: SLOTS[s.time.slot], amount, reason });
    if (s.ledger.length > RULES.ledgerSize) s.ledger.splice(0, s.ledger.length - RULES.ledgerSize);
  }

  /* ---------- home and achievements (M5) ---------- */

  function homeScore(s) {
    let comfort = 0;
    let style = 0;
    const th = {};
    for (const id of s.home.placed) { const f = FURNITURE[id]; comfort += f[2]; style += f[3]; if (f[4]) th[f[4]] = (th[f[4]] || 0) + 1; }
    const sets = Object.keys(th).filter((t) => th[t] >= 3); // a matching set of three: +3 comfort, +6 style
    comfort += sets.length * 3;
    style += sets.length * 6 + (s.home.shown || []).length * 2; // each keepsake on display: +2 style
    return { comfort: Math.min(100, comfort), style: Math.min(100, style), sets };
  }

  const countBy = (list) => { const c = {}; for (const x of list) c[x] = (x in c ? c[x] : 0) + 1; return c; };

  // How many placed pieces do not fit into their own slot type (must use "any" slots).
  function extrasNeeded(placed) {
    const c = countBy(placed.map((id) => FURNITURE[id][0]));
    let n = 0;
    for (const t of Object.keys(c)) n += Math.max(0, c[t] - (BASE_SLOTS[t] || 0));
    return n;
  }

  const anySlots = (level) => HOUSE[level].slots - HOUSE[1].slots;

  function doHomePlace(s, value, warnings) {
    const id = firstWord(value);
    if (!FURNITURE[id]) { warnings.push(`home.place: unknown furniture "${value}"`); return; }
    const owned = s.inventory[id] || 0;
    const placed = s.home.placed.filter((x) => x === id).length;
    if (placed >= owned) { warnings.push(`home.place: ${id} is not owned or already placed (item.add it first)`); return; }
    if (extrasNeeded([...s.home.placed, id]) > anySlots(s.home.level)) { warnings.push(`home.place: no free ${FURNITURE[id][0]} slot`); return; }
    s.home.placed.push(id);
  }

  function doHomeRemove(s, value, warnings) {
    const id = firstWord(value);
    const i = s.home.placed.indexOf(id);
    if (i === -1) { warnings.push(`home.remove: ${id} is not placed`); return; }
    s.home.placed.splice(i, 1);
  }

  // Keepsakes: anything in the bag that is not furniture, and any collectible already found, can go on display.
  const canShow = (s, id) => !FURNITURE[id] && ((s.inventory[id] || 0) > 0 || s.collection.includes(id));
  function doHomeShow(s, value, warnings) {
    const id = firstWord(value).replace(/[^a-z0-9_]/g, '');
    if (!s.home.shown) s.home.shown = [];
    if (!id || !canShow(s, id)) { warnings.push(`home.show: "${value}" is not a keepsake the player owns`); return; }
    if (s.home.shown.includes(id)) return;
    if (s.home.shown.length >= SHOW_CAP[s.home.level]) { warnings.push('home.show: the display shelf is full'); return; }
    s.home.shown.push(id);
  }
  function doHomeUnshow(s, value) {
    const id = firstWord(value).replace(/[^a-z0-9_]/g, '');
    s.home.shown = (s.home.shown || []).filter((x) => x !== id);
  }

  function doHouseUpgrade(s, value, warnings, alerts) {
    const n = parseInt(String(value).trim(), 10);
    if (!(n >= 2 && n <= 4)) { warnings.push(`house.upgrade: expected 2 to 4, got "${value}"`); return; }
    if (s.home.pending) { warnings.push('house.upgrade: an upgrade is already being built'); return; }
    if (n !== s.home.level + 1) { warnings.push(`house.upgrade: next level is ${s.home.level + 1}, not ${n}`); return; }
    s.home.pending = n;
    alerts.push(`House upgrade to ${HOUSE[n].name} ordered ($${HOUSE[n].price}); it is ready tomorrow morning.`);
  }

  // Furniture that left the inventory (sold, given away) can no longer be placed.
  function reconcileHome(s, alerts) {
    const seen = {};
    s.home.placed = s.home.placed.filter((id) => {
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > (s.inventory[id] || 0)) { alerts.push(`${id} is no longer in the home (not in inventory).`); return false; }
      return true;
    });
    s.home.shown = (s.home.shown || []).filter((id) => canShow(s, id)).slice(0, SHOW_CAP[s.home.level]);
  }

  const sideCount = (s, side, min) => NPCS.filter((id) => NPC_DATA[id].side === side && s.affinity[id] >= min).length;
  const setDone = (s, d) => COLLECT[d].every((id) => s.collection.includes(id));
  const ACHV = [
    ['first_whisker', 'N', 10], ['first_paycheck', 'A', 25, (s) => s.stats.shifts >= 1], ['first_harvest', 'N', 25],
    ['rainy_day_walk', 'N', 10], ['lazy_day', 'N', 50], ['homebody_week', 'A', 50, (s) => s.stats.homeNightStreak >= 7],
    ['rent_streak', 'A', 100, (s) => s.rent.streak >= 8], ['cozy_corner', 'A', 50, (s) => homeScore(s).comfort >= 40],
    ['showhome', 'A', 100, (s) => homeScore(s).style >= 70], ['homeowner_up', 'A', 100, (s) => s.home.level >= 2],
    ['dream_home', 'A', 500, (s) => s.home.level >= 4], ['skill_5_any', 'A', 100, (s) => SKILLS.some((k) => s.skills[k].level >= 5)],
    ['jack_of_all', 'A', 150, (s) => SKILLS.every((k) => s.skills[k].level >= 3)], ['skill_10_any', 'A', 500, (s) => SKILLS.some((k) => s.skills[k].level >= 10)],
    ['big_catch', 'N', 100], ['promoted', 'A', 50, (s) => TRACKS.some((t) => s.career.tracks[t].level >= 2)],
    ['side_hustle', 'A', 100, (s) => TRACKS.filter((t) => s.career.tracks[t].level >= 2).length >= 2],
    ['career_peak', 'A', 300, (s) => TRACKS.some((t) => s.career.tracks[t].level >= 5)],
    ['first_friend', 'A', 50, (s) => NPCS.some((id) => s.affinity[id] >= 45)],
    ['town_regular', 'A', 75, (s) => NPCS.filter((id) => s.affinity[id] >= 10).length >= 8],
    ['heart_to_heart', 'A', 50, (s) => NPCS.some((id) => s.npc[id].events.includes(2))],
    ['host_with_the_most', 'N', 100], ['first_date', 'A', 100, (s) => NPCS.some((id) => ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 2)],
    ['best_friend', 'A', 200, (s) => NPCS.some((id) => s.affinity[id] >= 85)],
    ['year_one', 'A', 200, (s) => s.time.year >= 2 || (s.time.season === 3 && s.time.day >= 28)],
    ['whole_town', 'A', 150, (s) => NPCS.every((id) => s.affinity[id] >= 10)],
    ['friend_circle', 'A', 100, (s) => NPCS.filter((id) => s.affinity[id] >= 45).length >= 3],
    ['full_heart', 'A', 150, (s) => NPCS.some((id) => s.npc[id].events.includes(4))],
    ['picked_a_side', 'A', 50, (s) => Math.abs(s.lean) >= RULES.leanSide],
    ['both_sides', 'A', 150, (s) => sideCount(s, 'store', 45) >= 2 && sideCount(s, 'market', 45) >= 2],
    ['rival_romance', 'A', 150, (s) => rivalRomances(s).length > 0],
    ['peacemaker', 'N', 150], ['spring_dance', 'N', 100], ['fireworks_company', 'N', 75], ['jelly_night', 'N', 50], ['new_year_kiss', 'N', 100],
    ['first_find', 'A', 10, (s) => s.collection.length >= 1],
    ['set_downtown', 'A', 75, (s) => setDone(s, 'downtown')], ['set_makers', 'A', 75, (s) => setDone(s, 'makers_row')],
    ['set_meadow', 'A', 75, (s) => setDone(s, 'meadow')], ['set_harbor', 'A', 75, (s) => setDone(s, 'harbor')],
    ['set_hilltop', 'A', 75, (s) => setDone(s, 'hilltop')], ['collector_all', 'A', 300, (s) => s.collection.length >= COLLECT_ALL_COUNT],
  ].map(([id, type, reward, check]) => ({ id, type, reward, check }));
  const ACHV_BY_ID = Object.fromEntries(ACHV.map((a) => [a.id, a]));
  const ACHV_HOW = {
    first_whisker: 'the player eats at The Salty Whisker for the first time',
    first_harvest: 'the player sells a first crop',
    rainy_day_walk: 'a rainy Evening spent walking on Saltgate Pier or Lantern Hill',
    lazy_day: 'a whole day spent only resting, eating or relaxing: no job, no practice',
    big_catch: 'the player catches a top-tier fish',
    host_with_the_most: 'a party at home with 3 or more guests',
    peacemaker: 'at Thanksgiving Supper the player gets someone from each side to sit and talk together',
    spring_dance: 'the player dances with a partner who accepted at the Spring Dance',
    fireworks_company: 'the player spends Fireworks Night at the harbor with Fabian or Garrett',
    jelly_night: 'the player watches the Moonlight Jellies together with someone',
    new_year_kiss: 'a kiss at midnight at the New Year Countdown',
  };

  function unlockAchievement(s, a, alerts) {
    if (s.achievements.includes(a.id)) return;
    s.achievements.push(a.id);
    addLedger(s, a.reward, `Achievement: ${a.id}`);
    alerts.push(`Achievement unlocked: ${a.id} (+$${a.reward}).`);
  }

  function doAchv(s, value, warnings, alerts) {
    for (const part of String(value).split(/\s*,\s*/)) {
      const id = part.trim().toLowerCase();
      if (!id) continue;
      const a = ACHV_BY_ID[id];
      if (!a) warnings.push(`achv: unknown achievement "${part}"`);
      else if (a.type === 'A') warnings.push(`achv: ${id} is computed automatically; do not report it`);
      else unlockAchievement(s, a, alerts);
    }
  }

  function checkAchievements(s, alerts) {
    for (const a of ACHV) if (a.type === 'A' && !s.achievements.includes(a.id) && a.check(s)) unlockAchievement(s, a, alerts);
  }

  /* ---------- skills and careers (M3) ---------- */

  function xpMultiplier(s, skillId) {
    let bonus = 0;
    for (const t of s.player.traits) if (TRAIT_SKILL[t] === skillId) bonus += 0.2;
    if (s.player.traits.includes('night_owl') && s.time.slot >= 2) bonus += 0.1;
    return MOOD_XP[moodOf(s.needs)] * (1 + bonus);
  }

  function linkedSkillLevel(s, track) {
    const list = CAREER[track].skills;
    return list.length ? Math.max(...list.map((id) => s.skills[id].level)) : 0;
  }

  function doSkillXp(s, id, value, warnings, alerts) {
    if (!s.skills[id]) { warnings.push(`skill.${id}: unknown skill`); return; }
    const base = relNum(value);
    if (base === null || base < 0) { warnings.push(`skill.${id}: expected +N, got "${value}"`); return; }
    const sk = s.skills[id];
    if (base > 0 && !s.today.skills.includes(id)) s.today.skills.push(id);
    if (sk.level >= 10) return;
    sk.xp += roundHalfUp(base * xpMultiplier(s, id));
    while (sk.level < 10 && sk.xp >= skillNeed(sk.level)) {
      sk.xp -= skillNeed(sk.level);
      sk.level += 1;
      alerts.push(`Skill up: ${id} is now level ${sk.level}.`);
      if (sk.level === 3) alerts.push(`${id} level 3: mid-tier recipes, seeds, fish and crafts unlock.`);
      if (sk.level === 5 && !s.perks[id] && !s.pendingPerks.includes(id)) {
        s.pendingPerks.push(id);
        alerts.push(`${id} level 5: offer the player a perk choice (${PERKS[id].join(' or ')}). Report it with perk.pick: ${id}=<perk_id>.`);
      }
      if (sk.level === 7) alerts.push(`${id} level 7: top-tier items unlock.`);
      if (sk.level === 10) alerts.push(`${id} level 10: mastery title earned.`);
    }
    if (sk.level >= 10) sk.xp = 0;
  }

  function doPerkPick(s, value, warnings, alerts) {
    const m = String(value).trim().toLowerCase().match(/^([a-z]+)\s*=\s*([a-z_]+)$/);
    if (!m || !PERKS[m[1]]) { warnings.push(`perk.pick: expected skill=perk_id, got "${value}"`); return; }
    const [, skill, perk] = m;
    if (!PERKS[skill].includes(perk)) { warnings.push(`perk.pick: ${perk} is not a ${skill} perk`); return; }
    if (s.skills[skill].level < 5) { warnings.push(`perk.pick: ${skill} must be level 5`); return; }
    if (s.perks[skill]) { warnings.push(`perk.pick: ${skill} already has a perk`); return; }
    s.perks[skill] = perk;
    s.pendingPerks = s.pendingPerks.filter((x) => x !== skill);
    alerts.push(`Perk chosen: ${perk} (${skill}).`);
  }

  function doCareerXp(s, track, value, warnings, alerts) {
    if (!CAREER[track]) { warnings.push(`career.${track}: unknown track`); return; }
    const base = relNum(value);
    if (base === null || base < 0) { warnings.push(`career.${track}: expected +N, got "${value}"`); return; }
    if (s.career.current === null) doCareerSet(s, track, warnings, alerts); // an XP line implies the job
    if (s.career.current !== track) { warnings.push(`career.${track}: the player's job is ${s.career.current || 'none'}; use career.set first`); return; }
    s.career.tracks[track].xp += roundHalfUp(base * MOOD_XP[moodOf(s.needs)]);
    if (base > 0) { s.stats.shifts += 1; if (track !== 'freelance') s.today.careers.push(track); }
  }

  function doCareerSet(s, value, warnings, alerts) {
    const v = firstWord(value);
    if (v === 'none') { s.career.current = null; return; }
    if (!CAREER[v]) { warnings.push(`career.set: unknown track "${value}"`); return; }
    if (s.career.current !== v) {
      s.career.current = v;
      const lvl = s.career.tracks[v].level;
      alerts.push(`Career: now working in ${v} as ${CAREER[v].titles[lvl - 1]} (level ${lvl}).`);
    }
  }

  // What the current job still needs for its next level, or null.
  function promotionGates(s) {
    const cur = s.career.current;
    if (!cur || cur === 'freelance') return null;
    const tr = s.career.tracks[cur];
    if (tr.level >= 5) return null;
    const L = tr.level + 1;
    const mentor = CAREER[cur].mentor;
    const g = {
      next_level: L,
      next_title: CAREER[cur].titles[L - 1],
      career_xp: { have: tr.xp, need: CAREER_XP[L] },
      skill: { ids: CAREER[cur].skills, have: linkedSkillLevel(s, cur), need: CAREER_SKILL_GATE[L] },
      mentor: CAREER_MENTOR_GATE[L] ? { id: mentor, have: s.affinity[mentor], need: CAREER_MENTOR_GATE[L] } : null,
    };
    g.ready = g.career_xp.have >= g.career_xp.need && g.skill.have >= g.skill.need && (!g.mentor || g.mentor.have >= g.mentor.need);
    return g;
  }

  function checkPromotion(s, alerts) {
    const g = promotionGates(s);
    if (!g || !g.ready) return;
    const cur = s.career.current;
    s.career.tracks[cur].level = g.next_level;
    alerts.push(`Promotion! ${cur}: ${g.next_title} (level ${g.next_level}). Pay is now $${CAREER_PAY[g.next_level]} per shift.`);
  }

  const shiftToday = (s) => {
    const cur = s.career.current;
    if (!cur) return false;
    if (cur !== 'freelance' && festivalOf(s.time)) return false;
    return CAREER[cur].days.includes(weekday(s.time));
  };

  /* ---------- relationships (M4) ---------- */

  const tierOf = (a) => TIERS.find((t) => a >= t.min).name;
  const tierFloor = (a) => TIERS.find((t) => a >= t.min).min;
  const isBirthday = (t, id) => t.season === NPC_DATA[id].bday[0] && t.day === NPC_DATA[id].bday[1];

  function addFlag(s, f) { if (!s.flags.includes(f)) s.flags.push(f); }

  /* ---------- sides: Old Mill Market vs Ashcroft's (v2.0) ---------- */

  const sideOf = (id) => NPC_DATA[id].side;
  // The player's side: their job's side first, otherwise the gossip lean from politics choices.
  function playerSide(s) {
    const cur = s.career.current;
    if (cur && CAREER[cur].side) return CAREER[cur].side;
    if (s.lean >= RULES.leanSide) return 'store';
    if (s.lean <= -RULES.leanSide) return 'market';
    return null;
  }
  function rivalRomances(s) {
    const ps = playerSide(s);
    if (!ps) return [];
    return NPCS.filter((id) => sideOf(id) && sideOf(id) !== ps && ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 2);
  }
  function doSide(s, id, value, warnings) {
    const kind = firstWord(value);
    const ns = sideOf(id);
    if (!ns) { warnings.push(`side.${id}: ${NPC_DATA[id].name} does not take sides`); return; }
    if (!['agree', 'refuse', 'dodge'].includes(kind)) { warnings.push(`side.${id}: expected agree, refuse or dodge, got "${value}"`); return; }
    s.stats.lastPolitics = dayIndex(s.time);
    markContact(s, id);
    const dir = ns === 'store' ? 1 : -1;
    if (kind === 'agree') {
      s.affinity[id] = clamp(s.affinity[id] + RULES.sideGain, 0, 100);
      s.lean = clamp(s.lean + dir, -RULES.leanMax, RULES.leanMax);
    } else if (kind === 'refuse') {
      s.affinity[id] = clamp(s.affinity[id] - RULES.sideLoss, 0, 100);
      s.lean = clamp(s.lean - dir, -RULES.leanMax, RULES.leanMax);
    }
  }
  function politicsHook(s) {
    if (!['downtown', 'makers_row'].includes(s.place.district)) return null;
    const last = s.stats.lastPolitics;
    if (last !== null && dayIndex(s.time) - last < RULES.politicsGap) return null;
    const cand = peopleHere(s).filter((p) => p.spot === s.place.spot && p.met && sideOf(p.id) && s.affinity[p.id] >= 10);
    return cand.length ? cand[0].id : null;
  }

  function markContact(s, id) {
    const n = s.npc[id];
    if (!n.met && !s.today.met.includes(id)) s.today.met.push(id);
    if (n.metDay === null || n.metDay === undefined) n.metDay = dayIndex(s.time);
    n.met = true;
    n.lastContact = dayIndex(s.time);
  }

  // Positive gain after Mood, perk and NPC difficulty. 0 means no gain.
  function scaleGain(s, id, base) {
    if (base <= 0) return 0;
    let v = base;
    const mood = moodOf(s.needs);
    if (mood === 'Great') v += 1;
    else if (mood === 'Low') v -= 1;
    if (s.perks.charisma === 'warm_presence') v += 1;
    if (v <= 0) return 0;
    return Math.max(1, roundHalfUp(v * NPC_DATA[id].diff));
  }

  function npcIdFromKey(key) {
    const id = key.split('.')[1];
    return NPC_DATA[id] ? id : null;
  }

  function firstWord(v) { return String(v).trim().toLowerCase().split(/\s+/)[0]; }

  function doTalk(s, id, value, warnings) {
    const kind = firstWord(value);
    if (!(kind in TALK_BASE)) { warnings.push(`talk.${id}: unknown type "${value}"`); return; }
    const n = s.npc[id];
    markContact(s, id);
    if (!s.today.talks.includes(id)) s.today.talks.push(id);
    s.needs.social = clamp(s.needs.social + 10, 0, 100); // company is company: talking keeps the social need up by itself
    let gain;
    if (kind === 'small' && moodOf(s.needs) === 'Stressed') gain = 0;
    else if (kind === 'help' && n.helpedToday) { warnings.push(`talk.${id}: help already counted today`); gain = 0; }
    else gain = scaleGain(s, id, TALK_BASE[kind]);
    const ps = playerSide(s);
    const ns = sideOf(id);
    if (gain > 0 && ps && ns) gain = ps === ns ? gain + 1 : Math.max(0, gain - 1); // same side warms faster, the rival side cools
    if (gain > 0 && `${s.place.district}/${s.place.spot}` === homePlace(s) && homeScore(s).style >= 40) gain += 1; // stylish home
    if (kind === 'help') n.helpedToday = true;
    const applied = Math.max(0, Math.min(gain, RULES.dailyAffinityCap - n.todayGain));
    n.todayGain += applied;
    s.affinity[id] = clamp(s.affinity[id] + applied, 0, 100);
    if (!n.talked) {
      n.talked = true;
      if (s.player.traits.includes('charmer')) s.affinity[id] = clamp(s.affinity[id] + RULES.firstMeetBonus, 0, 100);
    }
  }

  function doGift(s, id, value, warnings) {
    const kind = firstWord(value);
    if (!(kind in GIFT_BASE)) { warnings.push(`gift.${id}: unknown reaction "${value}"`); return; }
    const n = s.npc[id];
    if (n.giftedToday) { warnings.push(`gift.${id}: already gave a gift today`); return; }
    n.giftedToday = true;
    markContact(s, id);
    s.today.gifts.push({ id, kind });
    const base = GIFT_BASE[kind] * (isBirthday(s.time, id) ? 3 : 1);
    const change = base > 0 ? scaleGain(s, id, base) : base;
    s.affinity[id] = clamp(s.affinity[id] + change, 0, 100);
  }

  function doEvent(s, id, value, warnings) {
    const k = parseInt(String(value).trim(), 10);
    if (!(k >= 1 && k <= 4)) { warnings.push(`event.${id}: expected 1 to 4, got "${value}"`); return; }
    const n = s.npc[id];
    if (n.events.includes(k)) { warnings.push(`event.${id}: event ${k} was already played`); return; }
    if (k > 1 && !n.events.includes(k - 1)) { warnings.push(`event.${id}: event ${k - 1} must be played first`); return; }
    if (s.affinity[id] < EVENT_AT[k - 1]) { warnings.push(`event.${id}: event ${k} needs affinity ${EVENT_AT[k - 1]}, has ${s.affinity[id]}`); return; }
    n.events.push(k);
    markContact(s, id);
    addFlag(s, `${id}_event${k}`);
    s.affinity[id] = clamp(s.affinity[id] + RULES.heartEventBonus, 0, 100);
  }

  function doAffinity(s, id, value, warnings) {
    const n = relNum(value);
    if (n === null) { warnings.push(`affinity.${id}: bad value "${value}"`); return; }
    s.npc[id].met = true;
    s.affinity[id] = clamp(s.affinity[id] + n, 0, 100);
  }

  function updateDoubleDating(s, alerts) {
    const active = NPCS.filter((id) => ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 2);
    const has = s.flags.includes('double_dating');
    if (active.length >= 2 && !has) {
      s.flags.push('double_dating');
      if (alerts) alerts.push('The player is romantically involved with two people. If either finds out, both lose 15 affinity (use affinity.<npc>: -15).');
    } else if (active.length < 2 && has) {
      s.flags = s.flags.filter((f) => f !== 'double_dating');
    }
  }

  function doRomance(s, id, value, warnings, alerts) {
    const stage = firstWord(value);
    const to = ROMANCE_STEPS.indexOf(stage);
    if (to === -1) { warnings.push(`romance.${id}: unknown step "${value}"`); return; }
    if (!NPC_DATA[id].romance) { warnings.push(`romance.${id}: ${NPC_DATA[id].name} is not romanceable`); return; }
    const n = s.npc[id];
    const from = ROMANCE_STEPS.indexOf(n.romance);
    const today = dayIndex(s.time);
    const a = s.affinity[id];
    if (to === 0) {
      if (from >= 2) {
        s.affinity[id] = clamp(a - RULES.breakupCost, 0, 100);
        alerts.push(`Breakup with ${NPC_DATA[id].name}: -${RULES.breakupCost} affinity.`);
      }
      n.romance = 'none';
      n.romanceSince = null;
      updateDoubleDating(s, alerts);
      return;
    }
    if (to !== from + 1) { warnings.push(`romance.${id}: cannot go from ${n.romance} to ${stage}`); return; }
    let need = null;
    if (stage === 'interested' && !(a >= 45 && n.events.includes(2))) need = 'affinity 45 and heart event 2';
    else if (stage === 'dating' && !(a >= 65 && n.events.includes(3))) need = 'affinity 65 and heart event 3';
    else if (stage === 'partnered' && !(a >= 75 && today - n.romanceSince >= RULES.partnerDays)) need = `affinity 75 and ${RULES.partnerDays} days of dating`;
    else if (stage === 'engaged' && !(a >= 90 && n.events.includes(4))) need = 'affinity 90 and heart event 4';
    else if (stage === 'married' && !(a >= 95 && today - n.romanceSince >= RULES.marriageDays && weekday(s.time) === 5)) need = `affinity 95, ${RULES.marriageDays} days since engagement and a Saturday`;
    if (need) { warnings.push(`romance.${id}: ${stage} needs ${need}`); return; }
    n.romance = stage;
    n.romanceSince = today;
    markContact(s, id);
    updateDoubleDating(s, alerts);
  }

  function applyRelationship(s, key, value, warnings, alerts) {
    const id = npcIdFromKey(key);
    if (!id) { warnings.push(`${key}: unknown townsperson`); return; }
    const before = s.affinity[id];
    applyRelationshipInner(s, id, key, value, warnings, alerts);
    const after = s.affinity[id];
    const t0 = tierOf(before), t1 = tierOf(after);
    if (t0 !== t1 && alerts) {
      const nm = NPC_DATA[id].name.split(' ')[0];
      if (after > before) alerts.push(`${nm} now sees the player as ${t1}: let their attitude shift on screen (see "With the player" in their entry).`);
      else alerts.push(`${nm} has cooled to ${t1}: let it show.`);
    }
  }

  function applyRelationshipInner(s, id, key, value, warnings, alerts) {
    const kind = key.split('.')[0];
    if (kind === 'talk') doTalk(s, id, value, warnings);
    else if (kind === 'gift') doGift(s, id, value, warnings);
    else if (kind === 'event') doEvent(s, id, value, warnings);
    else if (kind === 'affinity') doAffinity(s, id, value, warnings);
    else if (kind === 'romance') doRomance(s, id, value, warnings, alerts);
    else if (kind === 'side') doSide(s, id, value, warnings);
  }

  function applyDecay(s) {
    const now = dayIndex(s.time);
    for (const id of NPCS) {
      const n = s.npc[id];
      if (n.lastContact === null) continue;
      if (ROMANCE_STEPS.indexOf(n.romance) >= 3) continue; // partners and spouses do not drift
      const ref = Math.max(n.lastContact, n.lastDecay === null ? -Infinity : n.lastDecay);
      if (now - ref < RULES.decayDays) continue;
      const a = s.affinity[id];
      s.affinity[id] = Math.max(tierFloor(a), a - RULES.decayAmount);
      n.lastDecay = now;
    }
  }

  function endOfDay(s, alerts) {
    // 0. promotion for the day that is ending
    checkPromotion(s, alerts);
    // 1. daily NPC counters and decay of neglected friendships
    applyDecay(s);
    for (const id of NPCS) { const n = s.npc[id]; n.todayGain = 0; n.giftedToday = false; n.helpedToday = false; }

    // 2. home night streak (place at the end of Night)
    const here = `${s.place.district}/${s.place.spot}`;
    s.stats.homeNightStreak = here === homePlace(s) ? s.stats.homeNightStreak + 1 : 0;
    // ordinary sleep and breakfast happen off-screen so nobody has to micromanage them
    s.needs.energy = Math.max(s.needs.energy, here === homePlace(s) ? RULES.overnightEnergyHome : RULES.overnightEnergyAway);
    s.needs.hunger = Math.max(s.needs.hunger, RULES.overnightHunger);

    // 3. rent, if the day ending is a Sunday
    if (weekday(s.time) === 6) {
      const due = RULES.rent + s.rent.owed;
      if (s.money >= due) {
        addLedger(s, -due, s.rent.owed ? 'Rent (including arrears)' : 'Weekly rent');
        s.rent.owed = 0;
        s.rent.streak += 1;
        alerts.push(`Rent paid: $${due}.`);
      } else {
        s.rent.owed += RULES.rent;
        s.rent.streak = 0;
        alerts.push(`Rent could not be paid. Owed: $${s.rent.owed}.`);
        if (s.rent.owed >= RULES.evictionOwed && !s.flags.includes('eviction_warning')) {
          s.flags.push('eviction_warning');
          alerts.push('Three weeks of rent unpaid: play the eviction-warning scene.');
        }
      }
    }

    // 4. advance the date
    const t = s.time;
    t.day += 1;
    if (t.day > 28) {
      t.day = 1;
      t.season += 1;
      if (t.season > 3) { t.season = 0; t.year += 1; alerts.push(`A new year begins: Year ${t.year}.`); }
      alerts.push(`New season: ${SEASONS[t.season]}.`);
    }
    t.slot = 0;

    // 5. weather resets; the narrator sets the new day's weather
    s.weather = 'clear';

    s.today = emptyToday();

    if (s.home.pending) {
      s.home.level = s.home.pending;
      s.home.pending = null;
      alerts.push(`The house upgrade is finished: ${HOUSE[s.home.level].name}, ${HOUSE[s.home.level].slots} furniture slots.`);
    }

    const fest = festivalOf(t);
    if (fest) alerts.push(`Today is a festival: ${fest} (${FEST_DESC[fest]}). Afternoon and Evening; shifts are cancelled. Optional for the player.`);
    for (const id of NPCS) {
      if (isBirthday(t, id)) alerts.push(`Today is ${NPC_DATA[id].name}'s birthday: a gift is worth triple.`);
    }
    const nowIdx = dayIndex(t);
    for (const id of NPCS) {
      const n = s.npc[id];
      if (ROMANCE_STEPS.indexOf(n.romance) >= 2 && n.romanceSince !== null && nowIdx > n.romanceSince && (nowIdx - n.romanceSince) % 112 === 0) {
        alerts.push(`Anniversary: a year since the player and ${NPC_DATA[id].name.split(' ')[0]} became ${n.romance}. They remember, in their own way.`);
      }
    }
  }

  function advanceSlot(s, alerts, withDecay) {
    if (withDecay) {
      const d = RULES.decay;
      const homebody = s.player.traits.includes('homebody');
      s.needs.energy = clamp(s.needs.energy - d.energy, 0, 100);
      s.needs.hunger = clamp(s.needs.hunger - d.hunger, 0, 100);
      s.needs.social = clamp(s.needs.social - (homebody ? d.socialHomebody : d.social), 0, 100);
      if (s.needs.hunger === 0) s.needs.energy = clamp(s.needs.energy - RULES.hungerZeroEnergyPenalty, 0, 100);
    }
    s.time.slot += 1;
    if (s.time.slot > 3) endOfDay(s, alerts);
  }

  function applyNeed(s, key, value, warnings) {
    const v = String(value).trim();
    const abs = v.match(/^=\s*(\d+)$/);
    if (abs) { s.needs[key] = clamp(parseInt(abs[1], 10), 0, 100); return; }
    const n = relNum(v);
    if (n === null) { warnings.push(`${key}: bad value "${value}"`); return; }
    s.needs[key] = clamp(s.needs[key] + n, 0, 100);
  }

  const cleanText = (v, n) => String(v).replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

  function doMemo(s, id, value, warnings) {
    const t = cleanText(value, RULES.memoLen);
    if (!t) return;
    if (id === null) {
      if (!s.memos.some((m) => m.t === t)) s.memos.push({ d: dayIndex(s.time), t });
      if (s.memos.length > RULES.storyMemoKeep) s.memos.splice(0, s.memos.length - RULES.storyMemoKeep);
      return;
    }
    if (!NPC_DATA[id]) { warnings.push(`memo.${id}: unknown townsperson`); return; }
    const n = s.npc[id];
    if (!n.memos.some((m) => m.t === t)) n.memos.push({ d: dayIndex(s.time), t });
    if (n.memos.length > RULES.memoKeep) n.memos.splice(0, n.memos.length - RULES.memoKeep);
  }

  function doThought(s, id, value, warnings) {
    if (!NPC_DATA[id]) { warnings.push(`thought.${id}: unknown townsperson`); return; }
    const t = cleanText(value, 140);
    if (t) s.npc[id].thought = t;
  }

  // A time skip the player asked for: whole days pass off-screen and the morning after arrives.
  function skipDays(s, n, alerts) {
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const quiet = [];
      // on a longer skip the player keeps their routine: one paid shift per full working day
      const cur = s.career.current;
      if (n >= 2 && s.time.slot === 0 && cur && cur !== 'freelance' && shiftToday(s)) {
        addLedger(s, CAREER_PAY[s.career.tracks[cur].level], 'Shift (time skip)');
        s.career.tracks[cur].xp += 5;
        s.stats.shifts += 1;
      }
      do { advanceSlot(s, last ? alerts : quiet, false); } while (s.time.slot !== 0);
      if (!last) for (const a of quiet) if (/^(Rent|Promotion|Three weeks|A new year|New season)/.test(a)) alerts.push(a);
    }
    s.needs.social = Math.max(s.needs.social, 50);
    alerts.push(`Time skip: ${n} day${n > 1 ? 's' : ''} passed off-screen; it is now ${dateLabel(s.time)}, Morning. Sum the gap up in a line or two; nobody's feelings jumped while away.`);
  }

  function parseItem(value) {
    const m = String(value).trim().match(/^([a-z0-9_]+)(?:\s*x\s*(\d+))?$/i);
    if (!m) return null;
    return { id: m[1].toLowerCase(), qty: m[2] ? parseInt(m[2], 10) : 1 };
  }

  /**
   * Apply one parsed delta to state `s` (mutates it).
   * Order: identity/place/weather/flags/items → money → time (decay, day end)
   *        → need effects → pass-out.
   * Money is applied before time so that earnings in the same turn count
   * toward Sunday-night rent.
   */
  function applyDelta(s, parsed) {
    const warnings = [...parsed.warnings];
    const alerts = [];
    const deferred = [];
    let timeSlots = 0;
    let skip = 0;
    const needLines = [];
    const relLines = [];
    const growLines = [];
    const homeLines = [];
    const sceneIds = [];
    let placeChanged = false;
    const dayBefore = dayIndex(s.time);

    for (const { key, value } of parsed.lines) {
      { const sm = key.match(/^(?:talk|gift|event|romance|thought)\.([a-z]+)$/); if (sm && NPC_DATA[sm[1]]) sceneIds.push(sm[1]); }
      if (key === 'place') placeChanged = true;
      if (DEFERRED.test(key)) { deferred.push(key); continue; }
      if (key === 'home.place' || key === 'home.remove' || key === 'house.upgrade' || key === 'home.show' || key === 'home.unshow') { homeLines.push({ key, value }); continue; }
      if (key === 'achv') { doAchv(s, value, warnings, alerts); continue; }
      if (key === 'career.set') { doCareerSet(s, value, warnings, alerts); continue; }
      if (/^(skill\.|career\.)/.test(key) || key === 'perk.pick') { growLines.push({ key, value }); continue; }
      if (/^(talk|gift|event|affinity|romance|side)\./.test(key)) { relLines.push({ key, value }); continue; }
      if (key === 'memo') { doMemo(s, null, value, warnings); continue; }
      if (key.startsWith('memo.')) { doMemo(s, key.slice(5), value, warnings); continue; }
      if (key.startsWith('thought.')) { doThought(s, key.slice(8), value, warnings); continue; }
      switch (key) {
        case 'days': {
          const n = relNum(String(value).replace(/\s*days?$/i, ''));
          if (n === null || n < 1 || n > RULES.maxSkipDays) warnings.push(`days: must be +1 to +${RULES.maxSkipDays}, got "${value}"`);
          else skip = n;
          break;
        }
        case 'time': {
          const n = relNum(value);
          if (n === null || n < 1 || n > RULES.maxSlotsPerDelta) warnings.push(`time: must be +1 to +4, got "${value}"`);
          else timeSlots += n;
          break;
        }
        case 'place': {
          const m = String(value).trim().toLowerCase().match(/^([a-z_]+)\s*\/\s*([a-z0-9_]+)$/);
          if (!m || !DISTRICTS.includes(m[1])) warnings.push(`place: expected district/spot, got "${value}"`);
          else {
            s.place = { district: m[1], spot: m[2] };
            if (!s.today.districts.includes(m[1])) s.today.districts.push(m[1]);
          }
          break;
        }
        case 'weather': {
          const w = String(value).trim().toLowerCase();
          if (!WEATHER.includes(w)) warnings.push(`weather: unknown "${value}"`);
          else s.weather = w;
          break;
        }
        case 'money': {
          const n = relNum(value);
          if (n === null) warnings.push(`money: bad value "${value}"`);
          else {
            addLedger(s, n, n >= 0 ? 'Income' : 'Spending');
            if (n > 0) s.today.income += n;
            if (s.money < 0) alerts.push(`Money is negative: $${s.money}.`);
          }
          break;
        }
        case 'energy': case 'hunger': case 'social':
          needLines.push({ key, value });
          break;
        case 'trait': {
          for (const part of String(value).split(/\s*(?:,|\/|&|\band\b)\s*/i)) {
            const t = part.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/'/g, '');
            if (!t) continue;
            if (!TRAITS.includes(t)) warnings.push(`trait: unknown "${part}"`);
            else if (s.player.traits.includes(t)) { /* already set */ }
            else if (s.player.traits.length >= 2) warnings.push('trait: already has 2 traits');
            else s.player.traits.push(t);
          }
          s.player.created = s.player.traits.length >= 2;
          break;
        }
        case 'home': {
          const v = String(value).trim().toLowerCase().split('/')[0].replace(/[\s-]+/g, '_');
          if (!HOMES[v]) warnings.push(`home: expected a district, got "${value}"`);
          else s.player.home = v;
          break;
        }
        case 'pronouns': case 'look': case 'backstory': case 'personality': case 'details': {
          const lim = key === 'pronouns' ? 30 : key === 'details' ? 400 : 320;
          const v = String(value).replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, lim);
          if (v) s.player[key] = v;
          break;
        }
        case 'name': {
          const nm = String(value).replace(/[<>{}]/g, '').trim().slice(0, 40);
          if (nm) s.player.name = nm;
          break;
        }
        case 'flag': {
          const f = String(value).trim().toLowerCase();
          if (!/^[a-z0-9_]+(=[a-z0-9_]+)?$/.test(f)) { warnings.push(`flag: bad name "${value}"`); break; }
          const base = f.split('=')[0];
          s.flags = s.flags.filter((x) => x.split('=')[0] !== base || x === f);
          if (!s.flags.includes(f)) s.flags.push(f);
          break;
        }
        case 'ui': break; // marker written by the panel next to its own lines; carries no change
        case 'flag.clear': {
          const base = String(value).trim().toLowerCase().split('=')[0];
          s.flags = s.flags.filter((x) => x.split('=')[0] !== base);
          break;
        }
        case 'collect': {
          const id = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
          const d = COLLECT_DISTRICT[id];
          if (!d) warnings.push(`collect: unknown collectible "${value}"`);
          else if (s.collection.includes(id)) warnings.push(`collect: ${id} is already in the collection`);
          else if (d !== s.place.district) warnings.push(`collect: ${id} is found in ${d}, but the player is in ${s.place.district}`);
          else if (s.today.collected.includes(d)) warnings.push(`collect: something was already found in ${d} today`);
          else {
            s.collection.push(id);
            s.today.collected.push(d);
            alerts.push(`New collectible: ${id} (${s.collection.filter((x) => COLLECT_DISTRICT[x] === d).length}/${COLLECT[d].length} in ${d}).`);
          }
          break;
        }
        case 'item.add': {
          const it = parseItem(value);
          if (!it) warnings.push(`item.add: bad value "${value}"`);
          else s.inventory[it.id] = (s.inventory[it.id] || 0) + it.qty;
          break;
        }
        case 'item.remove': {
          const it = parseItem(value);
          if (!it) { warnings.push(`item.remove: bad value "${value}"`); break; }
          const have = s.inventory[it.id] || 0;
          if (have < it.qty) { warnings.push(`item.remove: only ${have} × ${it.id}`); break; }
          if (have === it.qty) delete s.inventory[it.id];
          else s.inventory[it.id] = have - it.qty;
          break;
        }
        default:
          warnings.push(`unknown key "${key}"`);
      }
    }

    // Home lines run after every item change of the turn.
    for (const { key, value } of homeLines) {
      if (key === 'home.place') doHomePlace(s, value, warnings);
      else if (key === 'home.remove') doHomeRemove(s, value, warnings);
      else if (key === 'home.show') doHomeShow(s, value, warnings);
      else if (key === 'home.unshow') doHomeUnshow(s, value);
      else doHouseUpgrade(s, value, warnings, alerts);
    }
    reconcileHome(s, alerts);

    // Growth and relationship lines run in written order, before time advances.
    for (const { key, value } of growLines) {
      if (key === 'perk.pick') doPerkPick(s, value, warnings, alerts);
      else if (key.startsWith('skill.')) doSkillXp(s, key.slice(6), value, warnings, alerts);
      else doCareerXp(s, key.slice(7), value, warnings, alerts);
    }
    for (const { key, value } of relLines) applyRelationship(s, key, value, warnings, alerts);

    if (timeSlots > RULES.maxSlotsPerDelta) {
      warnings.push(`time: ${timeSlots} slots in one turn, capped at ${RULES.maxSlotsPerDelta}`);
      timeSlots = RULES.maxSlotsPerDelta;
    }
    for (let i = 0; i < timeSlots; i++) advanceSlot(s, alerts, true);
    if (skip) skipDays(s, skip, alerts);

    for (const { key, value } of needLines) applyNeed(s, key, value, warnings);

    if (s.needs.energy === 0) {
      advanceSlot(s, alerts, false);
      s.needs.energy = RULES.passOutEnergy;
      alerts.push('The player passed out from exhaustion and lost a time slot.');
    }
    if (s.needs.hunger === 0) alerts.push('Hunger is at 0: the player cannot work until they eat.');

    checkAchievements(s, alerts);

    // Who shares the scene: the people this reply was about. They stay until the player moves on or the day ends.
    if (sceneIds.length) s.scene = [...new Set(placeChanged || dayIndex(s.time) !== dayBefore ? sceneIds : [...(s.scene || []), ...sceneIds])].slice(-4); // same place: earlier company stays
    else if (placeChanged || dayIndex(s.time) !== dayBefore) s.scene = [];

    return { warnings, alerts, deferred };
  }

  /**
   * Rebuild state from chat messages (oldest first).
   * messages: [{message_id, role, message}]
   */
  // cache: optional Map(message_id -> {len, tail, parsed}) so unchanged replies are not re-parsed.
  // ckpt: optional {len, tail, state} saved earlier. If that message is still in the chat, replay starts
  // after it, so deleting or hiding very old messages does not reset the game. Returns a fresh ckpt
  // (RULES.ckptLag deltas behind the latest, so swipes and edits of recent replies still replay).
  function replay(messages, cache, ckpt) {
    let s = freshState();
    let start = 0;
    let usedCkpt = false;
    if (ckpt && ckpt.state && typeof ckpt.len === 'number') {
      for (let i = messages.length - 1; i >= 0; i--) {
        const t = typeof messages[i].message === 'string' ? messages[i].message : '';
        if (messages[i].role !== 'user' && t.length === ckpt.len && t.slice(-400) === ckpt.tail) {
          s = normalize(JSON.parse(JSON.stringify(ckpt.state)));
          start = i + 1;
          usedCkpt = true;
          break;
        }
      }
    }
    const items = [];
    let latestAssistantHasDelta = true;
    for (let i = start; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') continue; // hidden replies may come back with another role; anything not from the user counts
      const text = typeof m.message === 'string' ? m.message : '';
      let parsed;
      let inner;
      const hit = cache && cache.get(m.message_id);
      if (hit && hit.len === text.length && hit.tail === text.slice(-400)) {
        ({ parsed, inner } = hit);
      } else {
        inner = extractDelta(text);
        parsed = inner === null ? null : parseDelta(inner);
        if (cache) cache.set(m.message_id, { len: text.length, tail: text.slice(-400), parsed, inner });
      }
      if (m.role === 'assistant') latestAssistantHasDelta = inner !== null || m.message_id === 0;
      if (inner !== null) items.push({ m, text, parsed });
    }
    let last = null;
    let applied = 0;
    let nextCkpt = usedCkpt ? ckpt : null;
    const allWarnings = [];
    const target = items.length - 1 - RULES.ckptLag;
    items.forEach((it, k) => {
      // applyDelta mutates nothing in `parsed`, so the cached parse can be reused safely
      const res = applyDelta(s, it.parsed);
      applied += 1;
      if (res.warnings.length) allWarnings.push({ id: it.m.message_id, warnings: res.warnings });
      last = { id: it.m.message_id, ...res };
      if (k === target) nextCkpt = { len: it.text.length, tail: it.text.slice(-400), state: JSON.parse(JSON.stringify(s)) };
    });
    return { state: s, last, applied, allWarnings, latestAssistantHasDelta, ckpt: nextCkpt, usedCkpt };
  }

  /* ---------- schedules: who is where right now ---------- */

  // [weekdays "0-4" or "0-3,5" (0 = Mon), slots "MAEN", "district/spot"]; first match wins, otherwise at home / away.
  const SCHED = {
    damon:   [['6', 'M', 'downtown/store_office'], ['6', 'A', 'harbor/pier'], ['0-5', 'MA', 'downtown/ashcroft_store'], ['0-6', 'E', 'downtown/store_office'], ['0-6', 'N', 'downtown/ashcroft_store']],
    julius:  [['5', 'A', 'makers_row/finch_teahouse'], ['0-4', 'M', 'downtown/rourke_office'], ['0-4', 'A', 'downtown/ashcroft_store'], ['0-5', 'E', 'downtown/nocturne_bar'], ['6', 'E', 'harbor/salty_whisker']],
    callum:  [['6', 'A', 'makers_row/old_mill_market'], ['0-5', 'MA', 'downtown/construction_site'], ['0-4', 'E', 'harbor/salty_whisker'], ['0-6', 'N', 'harbor/pier']],
    celeste: [['1,3', 'E', 'makers_row/finch_teahouse'], ['6', 'M', 'makers_row/finch_teahouse'], ['0-4', 'M', 'downtown/ashcroft_store'], ['0-4', 'A', 'downtown/town_square'], ['0,2,4', 'E', 'downtown/nocturne_bar'], ['5', 'MA', 'downtown/ashcroft_store']],
    fabian:  [['6', 'A', 'hilltop/glass_greenhouse'], ['0-5', 'A', 'makers_row/street_stage'], ['0-5', 'E', 'makers_row/old_mill_market'], ['0-6', 'N', 'harbor/food_stalls']],
    holden:  [['5', 'M', 'makers_row/old_mill_market'], ['6', 'A', 'hilltop/sunflower_field'], ['0-5', 'MA', 'makers_row/sakaki_pottery'], ['0-4', 'E', 'makers_row/sakaki_pottery']],
    garrett: [['6', 'M', 'meadow/pond'], ['1,3', 'A', 'makers_row/old_mill_market'], ['0,2,4', 'A', 'meadow/hale_farm'], ['5', 'A', 'downtown/clinic'], ['0-5', 'M', 'meadow/mercer_farm'], ['0-6', 'E', 'meadow/mercer_farm']],
    rowan:   [['5', 'M', 'makers_row/old_mill_market'], ['6', 'A', 'hilltop/sunflower_field'], ['0-5', 'M', 'meadow/hale_farm'], ['0-4', 'A', 'meadow/orchard'], ['1,3', 'E', 'harbor/salty_whisker']],
    sasha:   [['6', 'M', 'harbor/fish_market'], ['6', 'E', 'harbor/pier'], ['0-5', 'MAE', 'harbor/salty_whisker']],
    jett:    [['0-6', 'A', 'downtown/town_square'], ['0-6', 'E', 'harbor/food_stalls'], ['0-6', 'N', 'harbor/salty_whisker']],
    vesper:  [['5-6', 'M', 'makers_row/old_mill_market'], ['0-4', 'M', 'hilltop/glass_greenhouse'], ['0-6', 'A', 'hilltop/sunflower_field'], ['0-6', 'EN', 'hilltop/stargazing_rock']],
    howard:  [['6', 'A', 'meadow/pond'], ['0-5', 'MAE', 'makers_row/finch_teahouse']],
    mabel:   [['6', 'M', 'makers_row/flower_shop'], ['0-5', 'MAE', 'makers_row/finch_teahouse']],
    nell:    [['5', 'E', 'harbor/food_stalls'], ['0-6', 'MA', 'hilltop/windmill']],
    maggie:  [['0-4', 'E', 'makers_row/finch_teahouse'], ['0-5', 'MA', 'downtown/store_office']],
    pip:     [['5-6', 'MA', 'meadow/pond'], ['0-4', 'M', 'makers_row/old_mill_market'], ['0-4', 'A', 'makers_row/street_stage']],
    gus:     [['0-5', 'M', 'harbor/pier'], ['0-5', 'A', 'harbor/fish_market'], ['0-6', 'E', 'harbor/food_stalls']],
    ada:     [['0-5', 'MA', 'downtown/clinic'], ['0-4', 'E', 'downtown/nocturne_bar']],
    bea:     [['5', 'E', 'harbor/beach'], ['0-5', 'MA', 'makers_row/flower_shop']],
  };
  const FEST_PLACE = {
    'Love Day': 'downtown/town_square', 'Egg Hunt': 'meadow/fairground', 'Spring Dance': 'hilltop/sunflower_field', 'Spring Market Day': 'makers_row/old_mill_market',
    'Beach Party': 'harbor/beach', 'Cat Festival': 'harbor/pier', 'Fireworks Night': 'downtown/rooftop_terrace', 'Moonlight Jellies': 'harbor/lighthouse',
    'Sunflower Festival': 'hilltop/sunflower_field', 'Harvest Fair': 'meadow/fairground', 'Thanksgiving Supper': 'makers_row/finch_teahouse', 'Halloween Night': 'hilltop/hill_maze',
    'Ice Festival': 'meadow/pond', 'Winter Market': 'makers_row/old_mill_market', 'Winter Star': 'downtown/town_square', 'New Year Countdown': 'hilltop/windmill',
  };
  // store-side people stay at the store's rival sale on market days
  const FEST_SIDE = { 'Spring Market Day': 'downtown/ashcroft_store', 'Winter Market': 'downtown/ashcroft_store' };
  // two people who cannot stand loud bangs hide at the harbor during the fireworks
  const FEST_EXCEPT = { 'Fireworks Night': { fabian: 'harbor/lighthouse', garrett: 'harbor/lighthouse' } };
  // short role, used before the player knows a name
  const ROLE = {
    damon: ['백화점 사장', 'the department store owner'], julius: ['삐딱하게 웃는 사업가', 'the businessman with the crooked smile'],
    callum: ['지친 얼굴의 건축가', 'the tired-looking architect'], celeste: ['금발의 모델', 'the blonde model'],
    fabian: ['거리 마술사', 'the street magician'], holden: ['도예가', 'the potter'], garrett: ['흉터 있는 농부', 'the scarred farmer'],
    rowan: ['밀짚모자 농부', 'the farmer in a straw hat'], sasha: ['카페 셰프', 'the cafe chef'], jett: ['오토바이 청년', 'the motorbike kid'],
    vesper: ['은발의 연금술사', 'the silver-haired alchemist'], howard: ['찻집 할아버지', 'the old man at the teahouse'],
    mabel: ['찻집 할머니', 'the old woman at the teahouse'], nell: ['풍차지기 할머니', 'the windmill keeper'], maggie: ['사장 비서', 'the store secretary'],
    pip: ['신문 배달 소년', 'the paper boy'], gus: ['늙은 어부', 'the old fisherman'], ada: ['마을 의사', 'the town doctor'], bea: ['꽃집 주인', 'the florist'],
  };

  function parseDays(spec) {
    const out = [];
    for (const part of spec.split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let d = a; d <= (b === undefined ? a : b); d++) out.push(d);
    }
    return out;
  }
  const SCHED_PARSED = Object.fromEntries(Object.entries(SCHED).map(([id, rules]) => [id,
    rules.map(([d, sl, place]) => ({ days: parseDays(d), slots: [...sl].map((c) => 'MAEN'.indexOf(c)), place }))]));

  // Where an NPC is now: {district, spot} or null (at home / away / asleep).
  function whereIs(s, id, t = s.time) {
    const fest = festivalOf(t);
    if (fest && (t.slot === 1 || t.slot === 2)) {
      const ex = FEST_EXCEPT[fest] && FEST_EXCEPT[fest][id];
      const place = ex || (FEST_SIDE[fest] && NPC_DATA[id].side === 'store' ? FEST_SIDE[fest] : FEST_PLACE[fest]);
      const [district, spot] = place.split('/');
      return { district, spot };
    }
    if (s.npc && s.npc[id] && s.npc[id].romance === 'married' && t.slot === 3) { const [district, spot] = homePlace(s).split('/'); return { district, spot }; }
    const wd = weekday(t);
    for (const r of SCHED_PARSED[id]) {
      if (r.days.includes(wd) && r.slots.includes(t.slot)) {
        let [district, spot] = r.place.split('/');
        if (spot === 'pier' && s.weather === 'snow') spot = 'fish_market'; // snow closes the pier
        return { district, spot };
      }
    }
    return null;
  }

  function peopleHere(s) {
    return NPCS.map((id) => ({ id, at: whereIs(s, id) }))
      .filter((x) => x.at && x.at.district === s.place.district)
      .map((x) => ({ id: x.id, spot: x.at.spot, met: !!(s.npc[x.id].met || s.affinity[x.id] > 0) }));
  }

  /* ---------- looks of the day ---------- */

  // Small deterministic PRNG so a day always rolls the same values (swipe-safe).
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const LOOKS = [['cheerful', '기분 좋아 보여요', '😊'], ['as usual', '평소 같아요', '🙂'], ['a bit tired', '조금 피곤해 보여요', '😪'],
    ['excited', '들떠 보여요', '😆'], ['lost in thought', '생각이 많아 보여요', '🤔'], ['a little down', '조금 처져 보여요', '😔']];
  function looksToday(s, id) {
    if (isBirthday(s.time, id)) return { en: 'excited, it is their birthday', ko: '생일이라 들떠 있어요', emoji: '🎂' };
    const r = rng(dayIndex(s.time) * 131 + NPCS.indexOf(id) * 977 + 7);
    let i = Math.floor(r() * LOOKS.length);
    if (s.weather === 'rain' && i === 0 && r() < 0.5) i = 4;
    return { en: LOOKS[i][0], ko: LOOKS[i][1], emoji: LOOKS[i][2] };
  }

  /* ---------- action menu (M6) ---------- */

  const DISTRICT_TXT = {
    downtown: { en: 'Downtown', ko: '중심가', to: '중심가로' }, meadow: { en: 'Greenfield Meadow', ko: '들판', to: '들판으로' },
    harbor: { en: 'Saltgate Harbor', ko: '항구', to: '항구로' }, makers_row: { en: "Makers' Row", ko: '공방 거리', to: '공방 거리로' },
    hilltop: { en: 'Lantern Hill', ko: '언덕', to: '언덕으로' },
  };
  const SKILL_KO = { gardening: '원예', cooking: '요리', fishing: '낚시', crafting: '공예', charisma: '매력', art: '예술' };
  const TRACK_KO = { store: '백화점', cafe: '카페', farm: '농장', harbor: '항구', makers: '공방', freelance: '프리랜서' };
  const TRACK_EN = { store: "Ashcroft's department store", cafe: 'The Salty Whisker', farm: 'a farm', harbor: 'the harbor', makers: 'the Old Mill workshops', freelance: 'freelance work' };

  const KO_NAME = { damon: '데이먼', julius: '줄리어스', callum: '캘럼', celeste: '셀레스트', fabian: '파비안', holden: '홀든', garrett: '개럿', rowan: '로언',
    sasha: '사샤', jett: '제트', vesper: '베스퍼', howard: '하워드', mabel: '메이블', nell: '넬', maggie: '매기', pip: '핍', gus: '거스', ada: '에이다', bea: '비' };
  const firstName = (id) => NPC_DATA[id].name.split(' ')[0];

  /**
   * Quick actions for the current state. Each: {group, key, ko, en, textKo, textEn, enabled, note}.
   * They only compose a sentence for the player; the narrator still decides what happens.
   */
  function buildActions(s) {
    const A = [];
    const add = (group, key, ko, en, textKo, textEn, enabled = true, note = '') => A.push({ group, key, ko, en, textKo, textEn, enabled, note });
    const here = s.place.district;

    for (const d of DISTRICTS) {
      if (d === here) continue;
      add('move', `move_${d}`, DISTRICT_TXT[d].ko, `Go to ${DISTRICT_TXT[d].en}`,
        `${DISTRICT_TXT[d].to} 이동한다.`, `I head to ${DISTRICT_TXT[d].en}.`);
    }
    add('move', 'look_around', '🔎 주변 둘러보기', 'Look around', '주변을 천천히 둘러보며 눈에 띄는 걸 찾아본다.', 'I take a slow look around for anything interesting.',
      !s.today.collected.includes(here), '오늘 이 구역에서는 이미 하나 찾았어요');

    add('needs', 'nap', '낮잠', 'Nap', '낮잠을 잔다.', 'I take a nap.');
    add('needs', 'sleep', '잠자기', 'Sleep', '잠자리에 든다.', 'I go to sleep.');
    add('needs', 'rest', '벤치에서 쉬기', 'Rest on a bench', '벤치에 앉아 쉰다.', 'I rest on a bench.');
    add('needs', 'idle', '아무것도 안 하기', 'Do nothing', '아무것도 하지 않고 여유를 즐긴다.', 'I do nothing in particular and enjoy the moment.');
    add('needs', 'snack', '길거리 간식 ($5)', 'Street snack ($5)', '길거리 간식을 산다.', 'I buy a street snack.', s.money >= 5, '돈이 부족해요');
    add('needs', 'cafe', '카페 식사 ($12)', 'Cafe meal ($12)', '솔티 위스커에서 식사한다.', 'I have a meal at The Salty Whisker.', s.money >= 12, '돈이 부족해요');
    add('needs', 'cook', '집밥 ($4 재료)', 'Home cooking ($4)', '집에서 요리해 먹는다.', 'I cook a meal at home.', s.money >= 4, '돈이 부족해요');

    const cur = s.career.current;
    if (cur) {
      const ok = shiftToday(s) && s.needs.hunger > 0;
      add('work', 'shift', '근무하기', 'Work a shift', '근무한다.', 'I work my shift.', ok, !shiftToday(s) ? '오늘은 근무가 없어요' : '배고파서 일할 수 없어요');
      add('work', 'quit', '그만두기', 'Quit job', '지금 일을 그만둔다.', 'I quit my job.');
    } else {
      for (const t of TRACKS) if (t !== 'freelance') add('work', `job_${t}`, `${TRACK_KO[t]} 지원`, `Apply: ${TRACK_EN[t]}`, `${TRACK_KO[t]}에서 일자리를 구한다.`, `I look for a job at ${TRACK_EN[t]}.`);
    }
    add('work', 'oddjob', '소일거리', 'Odd job', '소일거리를 구한다.', 'I take an odd job for some quick cash.', s.needs.hunger > 0, '배고파서 일할 수 없어요');
    for (const k of SKILLS) add('practice', `practice_${k}`, `${SKILL_KO[k]} 연습`, `Practice ${k}`, `${SKILL_KO[k]} 연습을 한다.`, `I spend some time practicing ${k}.`);

    const sc = homeScore(s);
    add('home', 'rearrange', '가구 배치', 'Rearrange furniture', '집 가구 배치를 바꿔 본다.', 'I rearrange the furniture at home.');
    add('home', 'shop', '가구 쇼핑', 'Furniture shopping', '가구를 보러 간다.', 'I go furniture shopping.');
    add('home', 'party', '집들이 열기', 'Host a party', '집에서 파티를 연다.', 'I host a party at home.', sc.style >= 70, '스타일 70이 필요해요');
    if (s.home.level < 4) {
      const nx = HOUSE[s.home.level + 1];
      add('home', 'upgrade', `집 확장 ($${nx.price.toLocaleString('en-US')})`, `Upgrade house ($${nx.price})`, '집 확장을 신청한다.', 'I order the next house upgrade.',
        !s.home.pending && s.money >= nx.price, s.home.pending ? '이미 공사 중이에요' : '돈이 부족해요');
    }
    return A;
  }

  const SOCIAL = {
    talk:   { ko: '대화', en: 'Chat', textKo: (n) => `${n}에게 말을 건다.`, textEn: (n) => `I chat with ${n}.` },
    shared: { ko: '함께 활동', en: 'Spend time', textKo: (n) => `${n}에게 같이 시간을 보내자고 한다.`, textEn: (n) => `I spend time with ${n}, doing something together.` },
    help:   { ko: '도와주기', en: 'Help', textKo: (n) => `${n}에게 도울 일이 없는지 묻는다.`, textEn: (n) => `I ask ${n} if I can help with anything.` },
    gift:   { ko: '선물', en: 'Gift', textKo: (n) => `${n}에게 선물을 준다.`, textEn: (n) => `I give ${n} a gift.` },
  };

  function socialActions(s, id) {
    const n = s.npc[id];
    const known = n.met || s.affinity[id] > 0;
    const nameKo = known ? KO_NAME[id] : ROLE[id][0];
    const nameEn = known ? firstName(id) : ROLE[id][1];
    return Object.keys(SOCIAL).map((k) => ({
      key: `${k}_${id}`, kind: k, ko: SOCIAL[k].ko, en: SOCIAL[k].en,
      textKo: SOCIAL[k].textKo(nameKo), textEn: SOCIAL[k].textEn(nameEn),
      enabled: !(k === 'gift' && n.giftedToday) && !(k === 'help' && n.helpedToday),
      note: k === 'gift' ? '오늘 이미 선물했어요' : '오늘 이미 도왔어요',
    }));
  }

  /* ---------- what the narrator sees ---------- */

  // One small off-screen happening per day so the town feels alive (public facts only, seeded by the date).
  const TOWN_NEWS = [
    "Bea is telling everyone the street magician pulled a ring out of a customer's ear and kept it.",
    'Maggie was seen buying two lemon tarts instead of one.',
    "Someone chalked NOT FOR SALE on the new wing's fence again; Callum quietly left it there.",
    "Butter stole a sandal from the beach and buried it in Rowan's carrots.",
    'Captain the cat has taken over a fish crate; Gus is negotiating.',
    'Julius lost at chess to Howard again, smiling the whole time.',
    "Holden's kiln ran all night; a shelf of gold-mended cups appeared by morning.",
    'Nell swears the windmill turned backwards for a minute at dawn.',
    "Celeste's new billboard went up over the square; by noon someone had drawn a moustache on it.",
    "Jett's bike woke half the harbor at 3 a.m.; Sasha apologized with free coffee.",
    'A bouquet with no card was left on the Finch teahouse step.',
    "Damon ended a market stall's lease yesterday; the street is muttering.",
    "Pip is selling 'insider news' for one candy each.",
    "Vesper's stall sold out of a perfume called Yesterday in ten minutes.",
    'Garrett fixed the fairground fence overnight and denies it.',
    "Rowan's tomatoes took first pick at the market; he hid from the photographer.",
    'The food stalls are arguing over who makes the best skewers; Gus is the judge and has been bribed.',
    "Dr. Ada pinned up a notice: 'Sleep is not optional. Yes, Callum, this means you.'",
    "Fabian's pigeon returned a stolen wallet, with interest.",
    'The Rourke car idled outside the pawn shop for an hour, then left.',
  ];
  const townNews = (s) => TOWN_NEWS[Math.floor(rng(dayIndex(s.time) * 53 + 11)() * TOWN_NEWS.length)];

  const agoLabel = (now, d) => (now - d <= 0 ? 'today' : `${now - d}d ago`);
  const eventsLabel = (ev) => (ev.length ? `events ${ev.join(',')}` : null);

  // One-glance looks, shown only for people nearby the player has not met (their full entry is not loaded yet).
  const LOOK = {
    damon: 'very tall, slicked green-black hair, grey eyes, bottle-green suit', julius: 'pastel-green hair, magenta eyes, fang grin, snake tattoo on his neck',
    callum: 'black hair over one eye, tired grey eyes, long dark green coat', celeste: 'long ash-platinum hair, magenta cat eyes, beauty mark',
    fabian: 'long black hair tied low, violet eyes, tailcoat, a pigeon', holden: 'big and still, messy black hair, grey-green eyes, clay-dusted apron',
    garrett: 'huge, a silver streak in black hair, amber eyes, scars, flannel', rowan: 'sun-blond, green eyes, freckles, straw hat',
    sasha: 'silver-grey short hair, lollipop stick, black apron', jett: 'bleached blond streaked with black, amber eyes, leather jacket',
    vesper: 'waist-length silver hair, pale violet eyes, barefoot, a white rabbit',
  };
  const LOOK_RE = /둘러|살펴|찾아|구경|산책|탐색|탐험|수집|도감|뒤져|look|explor|search|wander|stroll|collect|browse/i;
  // The one love story the player has settled on: "flag: route=<npc>" (route=open cancels), or a single committed partner.
  function focusOf(s) {
    const f = s.flags.find((x) => x.startsWith('route='));
    if (f) { const id = f.slice(6); return NPC_DATA[id] && NPC_DATA[id].romance ? id : null; }
    const committed = NPCS.filter((id) => ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 3);
    return committed.length === 1 ? committed[0] : null;
  }
  const ACHV_SHORT = {
    first_whisker: 'first meal here', first_harvest: 'first crop sold', rainy_day_walk: 'rainy evening walk, pier or hill', lazy_day: 'a whole day of only rest',
    big_catch: 'top-tier fish', host_with_the_most: 'home party, 3+ guests', peacemaker: 'both sides talk at the supper', spring_dance: 'danced with a partner',
    fireworks_company: 'fireworks at the harbor with Fabian or Garrett', jelly_night: 'watched the jellies with someone', new_year_kiss: 'midnight kiss',
  };

  // What one townsperson is to the player, in a few words.
  function relLabel(s, id) {
    const n = s.npc[id];
    const now = dayIndex(s.time);
    const bits = [`${s.affinity[id]} ${tierOf(s.affinity[id])}`];
    if (n.romance !== 'none') bits.push(`${n.romance}${n.romanceSince !== null ? ` ${now - n.romanceSince}d` : ''}`);
    const ev = eventsLabel(n.events);
    if (ev) bits.push(ev);
    if (n.metDay !== null && n.metDay !== undefined && now - n.metDay > 0) bits.push(`known ${now - n.metDay}d`);
    return bits.join(', ');
  }

  // Compact view for the narrator: only what matters in this scene, no empty fields.
  function stateForPrompt(s, alerts, opts = {}) {
    const out = {};
    const put = (k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
      if (v === null || v === undefined || v === false || v === '') return;
      if (Array.isArray(v) && !v.length) return;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
      out[k] = v;
    };
    const now = dayIndex(s.time);
    const toSun = 6 - weekday(s.time);
    const here = `${s.place.district}/${s.place.spot}`;
    const atHome = here === homePlace(s);
    const fest = festivalOf(s.time);

    put('date', `${dateLabel(s.time)}, ${SLOTS[s.time.slot]}`);
    put('weather', s.weather);
    put('festival', fest);
    put('place', here + (atHome ? ' (home)' : ''));
    put('player', {
      name: s.player.name || undefined, pronouns: s.player.pronouns || undefined, look: s.player.look || undefined,
      backstory: s.player.backstory || undefined, personality: s.player.personality || undefined, details: s.player.details || undefined, traits: s.player.traits.length ? s.player.traits.join(', ') : undefined,
      home: `${HOMES[homeDistrict(s)].name} (${homePlace(s)})`,
    });
    put('money', s.money);
    put('mood', `${moodOf(s.needs)} (energy ${s.needs.energy}, hunger ${s.needs.hunger}, social ${s.needs.social})`);
    if (toSun <= 1 || s.rent.owed) put('rent', `$${RULES.rent + s.rent.owed} due ${toSun === 0 ? 'tonight' : 'tomorrow night'}${s.rent.owed ? `, $${s.rent.owed} overdue` : ''}`);
    const sk = Object.entries(s.skills).filter(([, k]) => k.level > 1).map(([id, k]) => `${id} L${k.level}`);
    put('skills', sk.join(', '));
    put('perks', Object.values(s.perks).join(', '));
    put('pending_perk_choices', s.pendingPerks.map((id) => `${id}: ${PERKS[id].join(' or ')}`));
    if (s.career.current) {
      const cur = s.career.current;
      const tr = s.career.tracks[cur];
      const g = promotionGates(s);
      put('job', `${cur}, ${CAREER[cur].titles[tr.level - 1]}, ${cur === 'freelance' ? '$18 + $2 per skill level per odd job' : `$${CAREER_PAY[tr.level]} per shift`}, shift today: ${shiftToday(s) ? 'yes' : 'no'}`
        + (g ? `; next ${g.next_title}: xp ${g.career_xp.have}/${g.career_xp.need}, ${g.skill.ids.join('/')} ${g.skill.have}/${g.skill.need}${g.mentor ? `, ${g.mentor.id} ${g.mentor.have}/${g.mentor.need}` : ''}` : ''));
    }
    if (atHome || s.home.pending) {
      const sc = homeScore(s);
      const placedCount = countBy(s.home.placed);
      const spare = Object.entries(s.inventory).filter(([id, q]) => FURNITURE[id] && q > (placedCount[id] || 0)).map(([id]) => id);
      put('home', {
        house: `level ${s.home.level}, ${s.home.placed.length}/${HOUSE[s.home.level].slots} slots, comfort ${sc.comfort}, style ${sc.style}`,
        placed: s.home.placed.join(', '),
        on_display: (s.home.shown || []).length ? s.home.shown.join(', ') : undefined,
        sets: sc.sets.length ? sc.sets.join(', ') : undefined,
        unplaced: spare.length ? spare.join(', ') : undefined,
        effects: [sc.comfort >= 40 ? 'home nap +45' : null, sc.comfort >= 60 ? 'home rest +25' : null,
          sc.style >= 40 ? 'visitors +1 affinity (auto)' : null, sc.style >= 70 ? 'parties unlocked' : null].filter(Boolean).join(', ') || undefined,
        upgrading: s.home.pending ? `level ${s.home.pending}, ready tomorrow morning` : undefined,
      });
    }
    const items = Object.entries(s.inventory).filter(([id]) => !FURNITURE[id]).map(([id, q]) => (q > 1 ? `${id} x${q}` : id));
    put('inventory', items.join(', '));
    const ps = playerSide(s);
    put('player_side', ps ? `${ps === 'store' ? "Ashcroft's side" : 'Old Mill Market side'} (${s.career.current && CAREER[s.career.current].side ? 'by job' : 'by gossip'})` : undefined);

    // people: everyone in this district, then the ones who matter elsewhere
    const scene = (s.scene || []).filter((id) => NPC_DATA[id]);
    const hereRaw = peopleHere(s);
    for (const id of scene) if (!hereRaw.some((p) => p.id === id)) hereRaw.push({ id, spot: s.place.spot, met: !!(s.npc[id].met || s.affinity[id] > 0) });
    const inScene = (p) => p.spot === s.place.spot || scene.includes(p.id); // on schedule here, or came along with the player
    const hereList = hereRaw.sort((a, b) => inScene(b) - inScene(a));
    const sameSpot = hereList.filter(inScene).map((p) => p.id);
    const focus = focusOf(s);
    const people = {};
    for (const p of hereList) {
      const n = s.npc[p.id];
      const withP = inScene(p);
      const bits = [withP ? 'with the player' : `at ${p.spot}`];
      bits.push(p.met ? relLabel(s, p.id) : `not met yet (${ROLE[p.id][1]}${!withP && LOOK[p.id] ? `: ${LOOK[p.id]}` : ''})`);
      const day = [n.giftedToday ? 'gifted today' : null, n.helpedToday ? 'helped today' : null, n.todayGain >= RULES.dailyAffinityCap ? 'talk cap reached' : null].filter(Boolean);
      if (day.length) bits.push(day.join(', '));
      if (withP) bits.push(`looks ${looksToday(s, p.id).en}`);
      people[p.id] = bits.join(' | ');
    }
    put('people_here', people);
    const cust = Object.keys(CUSTOM);
    if (cust.length) put('custom_people', Object.fromEntries(cust.map((id) => [id, `${NPC_DATA[id].name}, ${CUSTOM[id].role}, ${CUSTOM[id].romance ? 'romanceable' : 'friendship only'}`])));
    const sheets = {};
    for (const id of sameSpot.slice(0, 6)) if (NOTES[id]) sheets[id] = NOTES[id];
    put('profile_notes', sheets);
    if (focus) put('route', `${focus}: the love story the player has chosen. Everyone else stays a friend or a rival: no flirting, courting or heart events from them unless the player starts it.`);
    // elsewhere: every romantic interest, plus the four closest friends
    const others = {};
    const away = NPCS.filter((id) => !people[id] && (s.npc[id].met || s.affinity[id] > 0));
    const keep = new Set([...away.filter((id) => ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 1),
      ...away.filter((id) => s.affinity[id] >= 45).sort((x, y) => s.affinity[y] - s.affinity[x]).slice(0, 4)]);
    if (focus) for (const id of [...keep]) if (id !== focus && NPC_DATA[id].romance && ROMANCE_STEPS.indexOf(s.npc[id].romance) < 2) keep.delete(id);
    for (const id of away) {
      if (!keep.has(id)) continue;
      const w = whereIs(s, id);
      others[id] = `${relLabel(s, id)} | ${w ? `now at ${w.district}/${w.spot}` : 'at home or away'}`;
    }
    put('others', others);
    const memories = {};
    for (const id of NPCS) {
      const n = s.npc[id];
      if (!n.memos.length) continue;
      if (!(sameSpot.includes(id) || (people[id] && ROMANCE_STEPS.indexOf(n.romance) >= 1))) continue;
      memories[id] = n.memos.map((m) => `${agoLabel(now, m.d)}: ${m.t}`);
    }
    put('memories', memories);
    put('story_memos', s.memos.map((m) => `${agoLabel(now, m.d)}: ${m.t}`));

    // optional hooks
    const hook = politicsHook(s);
    if (hook) put('politics_hook_available', `${hook} may test which side the player is on (optional, then report side.${hook})`);
    const rivals = rivalRomances(s);
    if (rivals.length) put('rival_romance', `${rivals.join(', ')}: dating across the feud, so they meet in secret`);
    if (!s.today.collected.includes(s.place.district) && (opts.userText === undefined || LOOK_RE.test(opts.userText))) {
      const left = COLLECT[s.place.district].filter((id) => !s.collection.includes(id));
      if (left.length) { const r = rng(now * 37 + s.place.district.length); const opts = [...left].sort(() => r() - 0.5).slice(0, 3); put('collectible_here', `only if the player looks around: ${opts.join(', ')}`); }
    }
    const ready = [];
    for (const id of NPCS) {
      const n = s.npc[id];
      if (!n.met || !NPC_DATA[id].romance) continue; // only romanceable people have heart events
      const k = n.events.length + 1;
      if (k > 4 || s.affinity[id] < EVENT_AT[k - 1]) continue;
      if (focus && id !== focus) continue;
      ready.push({ id, k, here: !!people[id] });
    }
    ready.sort((x, y) => y.here - x.here);
    if (ready.length) put('heart_event_ready', ready.slice(0, 4).map((r) => `${r.id} event ${r.k}${r.here ? ' (here now)' : ''}`).join('; ') + '. Play one only when the moment fits, as a full scene from their entry, then report event.<id>: <n>.');
    const seekers = NPCS.filter((id) => {
      const n = s.npc[id];
      if (!n.met || n.lastContact === null || now - n.lastContact < RULES.seekGap) return false;
      if (sameSpot.includes(id)) return false;
      if (focus && id !== focus && NPC_DATA[id].romance) return false;
      return s.affinity[id] >= 25 || ROMANCE_STEPS.indexOf(n.romance) >= 1;
    });
    if (seekers.length && now % 2 === 0) {
      const who = pick(rng(now * 131 + 7), seekers);
      if (opts.scan) opts.scan.maybe = who;
      put('seeking_player', `${who} has not seen the player for ${now - s.npc[who].lastContact} days and may come looking today (a message, a visit, turning up with an excuse, in character). Optional, once.`);
    }
    const lovers = NPCS.filter((id) => ROMANCE_STEPS.indexOf(s.npc[id].romance) >= 1 && sameSpot.includes(id));
    const close = [...new Set([...s.today.talks, ...s.today.gifts.map((g) => g.id)])].filter((id) => NPC_DATA[id].romance);
    const jw = lovers.map((x) => { const o = close.filter((y) => y !== x); return o.length ? `${x} saw the player getting close to ${o.join(', ')} today` : null; }).filter(Boolean);
    if (jw.length) put('jealousy_watch', jw.join('; ') + ': let them react in their own jealousy style. No affinity change unless something real happened.');
    if (s.time.slot === 0) put('town_today', `${townNews(s)} (background color, use at most once)`);
    put('birthdays_today', NPCS.filter((id) => isBirthday(s.time, id)).join(', '));
    const ACHV_WHEN = {
      first_whisker: () => s.place.spot === 'salty_whisker', first_harvest: () => (s.skills.gardening.xp > 0 || s.skills.gardening.level > 1) && !atHome && s.place.district !== 'hilltop',
      rainy_day_walk: () => s.weather === 'rain' && s.time.slot >= 2, lazy_day: () => s.time.slot === 3 && !s.today.skills.length && !s.today.careers.length,
      big_catch: () => ['pier', 'beach', 'lighthouse', 'pond'].includes(s.place.spot) && (opts.userText === undefined || /낚|fish/i.test(opts.userText)), host_with_the_most: () => atHome && homeScore(s).style >= 70,
      peacemaker: () => fest === 'Thanksgiving Supper', spring_dance: () => fest === 'Spring Dance', fireworks_company: () => fest === 'Fireworks Night',
      jelly_night: () => fest === 'Moonlight Jellies', new_year_kiss: () => fest === 'New Year Countdown',
    };
    const award = ACHV.filter((a) => a.type === 'N' && !s.achievements.includes(a.id) && (!ACHV_WHEN[a.id] || ACHV_WHEN[a.id]()));
    if (award.length) put('achievements_to_award', award.map((a) => `${a.id} (${ACHV_SHORT[a.id] || ACHV_HOW[a.id]})`).join('; '));
    const fl = s.flags.filter((f) => !/_event\d$/.test(f) && !f.startsWith('route='));
    if (fl.length) put('flags', fl.join(', '));
    put('alerts', alerts || []);
    if (opts.scan) {
      const step = (id) => ROMANCE_STEPS.indexOf(s.npc[id].romance);
      opts.scan.ids = [...sameSpot].sort((x, y) => (step(y) - step(x)) || (s.affinity[y] - s.affinity[x])).slice(0, 5);
    }
    return out;
  }

  function stateBlock(s, alerts, opts) {
    return `<state>\n${JSON.stringify(stateForPrompt(s, alerts, opts))}\n</state>`;
  }

  // {state, scan}: the <state> block plus one short line whose only job is to wake the right lorebook entries
  // (this district and the people in the scene), so the narrator never has to invent a face or a voice.
  function promptParts(s, alerts, opts = {}) {
    const scan = { ids: [], maybe: null };
    const state = stateBlock(s, alerts, { ...opts, scan });
    const names = scan.ids.map(firstName);
    let line = `[Scene: ${DISTRICT_TXT[s.place.district].en}`;
    if (names.length) line += `. Present: ${names.join(', ')}`;
    if (scan.maybe && !scan.ids.includes(scan.maybe)) line += `. May turn up: ${firstName(scan.maybe)}`;
    return { state, scan: `${line}.]` };
  }

  return {
    HOMES, homePlace, homeDistrict,
    VERSION, SLOTS, SEASONS, WEEKDAYS, DISTRICTS, RULES, NPC_DATA, NPCS, TIERS, EVENT_AT, ROMANCE_STEPS,
    tierOf, tierFloor, isBirthday,
    buildActions, socialActions, firstName, KO_NAME, whereIs, peopleHere, SCHED, ROLE,
    SKILL_KO, TRACK_KO, TRACK_EN, DISTRICT_TXT, freshState, looksToday, dayIndex,
    COLLECT, COLLECT_DISTRICT, playerSide, sideOf, rivalRomances, politicsHook,
    FURNITURE, THEMES, SHOW_CAP, canShow, HOUSE, BASE_SLOTS, ACHV, ACHV_HOW, homeScore, extrasNeeded, anySlots,
    SKILL_PERKS: PERKS, CAREER, CAREER_XP, CAREER_PAY, skillNeed, promotionGates, shiftToday, xpMultiplier,
    initialState, extractDelta, parseDelta, applyDelta, replay, normalize, relLabel, townNews,
    moodOf, weekday, festivalOf, dateLabel, stateForPrompt, stateBlock, promptParts, focusOf, setCustom, BASE_NPCS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LH;

/* ============================ TAVERN HELPER ============================ */

if (typeof eventOn === 'function' && typeof getChatMessages === 'function') {
  (() => {
    const INJECT_ID = 'larkhaven_state';
    const SCAN_ID = 'larkhaven_scan';
    const UI_ID = 'larkhaven-ui';
    const STYLE_ID = 'larkhaven-style';
    const doc = window.parent.document; // the SillyTavern page

    const KO = {
      season: ['봄', '여름', '가을', '겨울'],
      weekday: ['월', '화', '수', '목', '금', '토', '일'],
      slot: ['아침', '오후', '저녁', '밤'],
      weather: { clear: '☀️ 맑음', rain: '🌧️ 비', wind: '🍃 바람', snow: '❄️ 눈' },
      district: { downtown: '중심가', meadow: '들판', harbor: '항구', makers_row: '공방 거리', hilltop: '언덕' },
      mood: { Great: '최고', Good: '좋음', Low: '처짐', Stressed: '스트레스' },
      tier: { Stranger: '낯선 사이', Acquaintance: '아는 사이', Friendly: '친근함', Friend: '친구', 'Close Friend': '가까운 친구', 'Best Friend': '단짝' },
      skill: { gardening: '원예', cooking: '요리', fishing: '낚시', crafting: '공예', charisma: '매력', art: '예술' },
      track: { store: '애쉬크로프트 백화점', cafe: '솔티 위스커', farm: '농장', harbor: '항구', makers: '올드 밀 공방', freelance: '프리랜서' },
      side: { store: '🏬 백화점 편', market: '🎨 시장 편' },
      perk: {
        fertile_hands: '비옥한 손', rain_whisperer: '비를 부르는 자', home_chef: '홈 셰프', market_cook: '시장 요리사',
        patient_angler: '참을성 있는 낚시꾼', deep_water: '깊은 물', master_hands: '장인의 손', repair_eye: '수리의 눈',
        warm_presence: '따뜻한 존재감', networker: '인맥왕', gallery_eye: '갤러리의 눈', muse: '뮤즈',
      },
      spot: {
        ashcroft_store: '애쉬크로프트 백화점', store_office: '사장실', rourke_office: '로크 개발 사무실', nocturne_bar: '루프탑 바 녹턴',
        construction_site: '신관 공사장', clinic: '마을 병원', town_square: '마을 광장', rooftop_terrace: '백화점 옥상 테라스', store_rooftop_garden: '옥상 정원',
        old_mill_market: '올드 밀 마켓', sakaki_pottery: '사카키 도자기 공방', finch_teahouse: '핀치 찻집', street_stage: '거리 무대', flower_shop: '꽃집', mill_attic: '방앗간 다락방',
        mercer_farm: '머서 농장', hale_farm: '헤일 농장', orchard: '과수원', pond: '연못', fairground: '들판 축제장', old_barn: '오래된 헛간', wren_cottage: '렌 코티지', glass_loft: '글라스하우스 로프트', mill_garret: '방앗간 다락방', gull_house: '갈매기 집', windrow_cottage: '윈드로 코티지',
        salty_whisker: '솔티 위스커', fish_market: '어시장', food_stalls: '포장마차 거리', lighthouse: '등대', beach: '해변', pier: '부두', cafe_attic: '카페 다락방',
        windmill: '풍차', sunflower_field: '해바라기 밭', glass_greenhouse: '유리 온실', stargazing_rock: '별 보는 바위', lantern_shrine: '등불 사당', hill_maze: '언덕 미로',
        festival: '축제장',
      },
      slotType: { living: '거실', kitchen: '주방', bedroom: '침실', study: '서재', porch: '현관', decor: '장식', any: '자유' },
      furn: {
        worn_sofa: ['🛋️', '낡은 소파'], linen_sofa: ['🛋️', '린넨 소파'], armchair: ['🪑', '안락의자'], woven_rug: ['🟫', '짜임 러그'],
        floor_lamp: ['💡', '스탠드'], houseplant: ['🪴', '화분'], framed_print: ['🖼️', '액자'], record_player: ['📻', '레코드 플레이어'],
        quilt: ['🧵', '퀼트'], farmhouse_table: ['🍽️', '농가 식탁'], pantry_shelf: ['🗄️', '식료품 선반'], single_bed: ['🛏️', '싱글 침대'],
        double_bed: ['🛏️', '더블 침대'], nightstand_lamp: ['🕯️', '협탁 램프'], writing_desk: ['🖋️', '책상'], bookshelf: ['📚', '책장'],
        easel: ['🎨', '이젤'], workbench: ['🔨', '작업대'], porch_swing: ['🪢', '현관 그네'], herb_planter: ['🌿', '허브 화분'],
        velvet_sofa: ['🛋️', '벨벳 소파'],
        glass_coffee_table: ['🫙', '유리 커피 테이블'],
        marble_island: ['🍸', '대리석 아일랜드'],
        espresso_machine: ['☕', '에스프레소 머신'],
        canopy_bed: ['🛏️', '캐노피 침대'],
        vanity_mirror: ['🪞', '화장대 거울'],
        crystal_lamp: ['💎', '크리스털 조명'],
        neon_sign: ['🌃', '네온 사인'],
        rocking_chair: ['🪑', '흔들의자'],
        gingham_curtains: ['🪟', '체크 커튼'],
        cast_iron_stove: ['🔥', '무쇠 난로'],
        patchwork_bed: ['🛏️', '패치워크 침대'],
        flower_box: ['🌷', '꽃 화단 상자'],
        net_hammock: ['🕸️', '그물 해먹'],
        ship_lantern: ['🏮', '선박 랜턴'],
        driftwood_table: ['🪵', '유목 테이블'],
        captain_chest: ['🧰', '선장의 궤짝'],
        cat_tower: ['🐈', '캣타워'],
        shell_chimes: ['🐚', '조개 풍경'],
        sakaki_tea_set: ['🍵', '사카키 다기 세트'],
        loom_tapestry: ['🧶', '베틀 태피스트리'],
        pottery_shelf: ['🏺', '도자기 진열 선반'],
        kintsugi_vase: ['⚱️', '킨츠기 꽃병'],
        magic_poster: ['🎩', '마술 공연 포스터'],
        sunflower_vase: ['🌻', '해바라기 꽃병'],
        moon_lamp: ['🌙', '달 조명'],
        rabbit_cushion: ['🐇', '토끼 쿠션'],
        star_mobile: ['⭐', '별 모빌'],
        perfume_cabinet: ['🧪', '향수 진열장'],
        windmill_model: ['🌬️', '풍차 모형'],
      },
      collect: {
        spring_ribbon: '봄 한정 리본', rooftop_coaster: '루프탑 코스터', black_rose_brooch: '흑장미 브로치', brothers_photo: '찢어진 형제 사진',
        window_star: '쇼윈도 별 장식', perfume_sample: 'VIP 향수 샘플', elevator_token: '엘리베이터 토큰', gold_sale_tag: '금색 세일 택',
        display_snowglobe: '진열용 스노우볼', founders_pin: '창립자 배지',
        potter_stamp: '도자기 도장', weaver_stamp: '직물 도장', magician_stamp: '마술사 도장', florist_stamp: '꽃집 도장', tea_stamp: '찻집 도장',
        mill_wheel_stamp: '물레방아 도장', kintsugi_stamp: '킨츠기 도장', market_bell_stamp: '시장 종 도장', chalk_art_stamp: '분필 그림 도장', centennial_stamp: '백주년 도장',
        old_sneaker: '낡은 운동화 한 짝', shiny_stone: '반짝이는 돌', dog_tag: '어느 병사의 군번줄', little_farmer_sticker: '리틀 파머 스티커',
        golden_apple: '황금빛 사과', lost_glove: '잃어버린 장갑', wooden_duck: '나무 오리', horseshoe: '말굽', old_seed_packet: '오래된 씨앗 봉투', love_letter_scrap: '연애편지 조각',
        cat_captain: '캡틴', cat_marmalade: '마멀레이드', cat_pepper: '페퍼', cat_shadow: '섀도', cat_biscuit: '비스킷',
        cat_sardine: '사딘', cat_admiral: '애드미럴', cat_mochi: '모찌', cat_ink: '잉크', cat_tofu: '두부',
        four_leaf_clover: '네잎클로버', sunflower_seed: '해바라기 씨앗', strange_bottle: '이상한 유리병', promise_letter_piece: '오래된 약속의 편지 조각',
        moon_pebble: '달 조약돌', white_feather: '흰 깃털', old_bell: '오래된 종', dried_lavender: '말린 라벤더', star_candy: '별사탕', lantern_wick: '등불 심지',
      },
      collectSet: { downtown: '🏬 백화점 한정 굿즈', makers_row: '🎨 장인 도장 카드', meadow: '🐕 버터의 보물', harbor: '🐈 부두 고양이 도감', hilltop: '🐇 흰토끼의 선물' },
      achv: {
        first_whisker: ['첫 한 그릇', '솔티 위스커에서 처음 식사하기'], first_paycheck: ['첫 월급', '첫 근무 마치기'], first_harvest: ['첫 수확', '첫 작물 팔기'],
        rainy_day_walk: ['빗속 산책', '비 오는 저녁 부두나 언덕 걷기'], lazy_day: ['아무것도 안 한 날', '일·연습 없이 쉬고 먹기만 한 하루'],
        homebody_week: ['집순이 주간', '집에서 7일 연속 자기'], rent_streak: ['성실한 세입자', '월세 8주 연속 납부'], cozy_corner: ['아늑한 구석', '편안함 40 이상'],
        showhome: ['쇼룸', '스타일 70 이상'], homeowner_up: ['집 확장', '집 2단계'], dream_home: ['꿈의 집', '집 4단계'], skill_5_any: ['숙련자', '아무 기술 Lv5'],
        jack_of_all: ['만능 일꾼', '기술 6개 모두 Lv3 이상'], skill_10_any: ['달인', '아무 기술 Lv10'], big_catch: ['대어', '최상급 물고기 낚기'],
        promoted: ['첫 승진', '처음 승진하기'], side_hustle: ['부업', '직업 두 개 Lv2 이상'], career_peak: ['정상에 서다', '직급 5 달성'],
        first_friend: ['첫 친구', '아무 주민과 친구(45)'], town_regular: ['마을 단골', '주민 8명과 아는 사이 이상'], heart_to_heart: ['마음을 나누다', '하트 이벤트 2 보기'],
        host_with_the_most: ['집들이', '집에서 손님 3명 이상 파티'], first_date: ['첫 데이트', '연애 단계 도달'], best_friend: ['단짝', '호감도 85 달성'],
        year_one: ['첫 해를 무사히', '겨울 28일 도달'], whole_town: ['온 마을이 아는 사이', '주민 모두와 아는 사이 이상'], friend_circle: ['친구 모임', '친구(45) 이상 3명'],
        full_heart: ['모든 속마음', '아무 주민의 하트 이벤트 4 보기'],
        picked_a_side: ['니편 내편', '정치질에서 한쪽 편을 확실히 들기'], both_sides: ['양다리 외교', '백화점 쪽 2명, 시장 쪽 2명과 친구'],
        rival_romance: ['적진 로맨스', '반대 진영 사람과 연애하기'], peacemaker: ['화해의 식탁', '추수감사 만찬에서 양쪽을 한자리에'],
        spring_dance: ['봄 무도회', '파트너와 봄 무도회에서 춤추기'], fireworks_company: ['불꽃 없는 밤', '불꽃놀이 밤을 항구에서 파비앙이나 개럿과'],
        jelly_night: ['달빛 해파리', '누군가와 달빛 해파리 보기'], new_year_kiss: ['자정의 키스', '새해 카운트다운 키스'],
        first_find: ['첫 발견', '수집품 하나 찾기'], set_downtown: ['백화점 굿즈 컴플리트', '중심가 수집 10종'], set_makers: ['장인 도장 컴플리트', '공방 거리 수집 10종'],
        set_meadow: ['버터의 보물상자', '들판 수집 10종'], set_harbor: ['부두 고양이 도감', '항구 고양이 10마리'], set_hilltop: ['흰토끼의 선물', '언덕 수집 10종'],
        collector_all: ['마을 수집왕', '수집품 50종 전부'],
      },
      romance: { none: '', interested: '💗 관심', dating: '💞 연애 중', partnered: '💑 파트너', engaged: '💍 약혼', married: '👰 결혼' },
    };

    let latest = null;     // last replay result
    let timer = null;
    let panelOpen = false;
    let panelTab = 'town';
    let pickedDistrict = null;
    let pickedNpc = null;

    /* ---------- settings (per viewer, kept in the browser; the game still works without it) ---------- */

    const SETTINGS_KEY = 'larkhaven_settings_v1';
    const DEFAULTS = { lang: 'ko', autoSend: false, closeAfter: true, barMode: 'full', imgBase: '', imgExt: '.png', img: {} };
    // Optional: put portrait URLs here instead of using the settings tab, e.g. damon: 'https://…/damon.png'
    const PORTRAITS = {
      damon: 'https://i.ibb.co/TMXsm3f5/4.png',
      rowan: 'https://i.ibb.co/0y7brGFW/5.png',
      vesper: 'https://i.ibb.co/2YjW9wjf/6.png',
      sasha: 'https://i.ibb.co/9kz3r1nT/7.png',
      celeste: 'https://i.ibb.co/fVyYb86m/8.png',
      jett: 'https://i.ibb.co/XkFVjt1J/9.png',
      julius: 'https://i.ibb.co/pvxMwHX6/10.png',
      callum: 'https://i.ibb.co/mFz4wmps/11.png',
      fabian: 'https://i.ibb.co/QFwJbT9T/12.png',
      holden: 'https://i.ibb.co/cXwL879B/13.png',
      garrett: 'https://i.ibb.co/7dGsSVtp/2.png',
    };
    let settings = { ...DEFAULTS };
    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          for (const k of Object.keys(DEFAULTS)) if (k in o && typeof o[k] === typeof DEFAULTS[k]) settings[k] = o[k];
          if (!['full', 'compact', 'min'].includes(settings.barMode)) settings.barMode = 'full';
          if (!['ko', 'en'].includes(settings.lang)) settings.lang = 'ko';
        }
      } catch (e) { /* storage may be blocked: defaults are fine */ }
    }
    function saveSettings() {
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
    }
    loadSettings();

    /* ---------- core ---------- */

    async function readMessages(excludeLastAssistant) {
      const msgs = await getChatMessages('0-{{lastMessageId}}');
      if (!Array.isArray(msgs)) return [];
      msgCount = msgs.length;
      lastGreeting = msgs[0] && typeof msgs[0].message === 'string' ? msgs[0].message : '';
      if (excludeLastAssistant && msgs.length && msgs[msgs.length - 1].role === 'assistant') return msgs.slice(0, -1);
      return msgs;
    }

    function stContext() {
      try {
        const st = typeof SillyTavern !== 'undefined' ? SillyTavern : window.parent.SillyTavern;
        return st && typeof st.getContext === 'function' ? st.getContext() : null;
      } catch (e) { return null; }
    }
    // True when this chat belongs to the Larkhaven card (by card name, greeting, or an existing <delta>).
    function isLarkhavenChat(msgs) {
      const c = stContext();
      if (c && typeof c.name2 === 'string' && /larkhaven/i.test(c.name2)) return true;
      if (/larkhaven|라크헤이븐/i.test(lastGreeting)) return true;
      return msgs.some((m) => m.role !== 'user' && typeof m.message === 'string' && m.message.includes('<delta>'));
    }
    function goSilent() {
      try { uninjectPrompts([INJECT_ID, SCAN_ID]); } catch (e) { /* nothing injected */ }
      const u = doc.getElementById(UI_ID); if (u) u.remove();
      const o = doc.getElementById(CAS_ID); if (o) o.remove();
      latest = null; lastJson = '';
    }

    function inject(result, userText) {
      try { uninjectPrompts([INJECT_ID, SCAN_ID]); } catch (e) { /* nothing injected yet */ }
      const alerts = (result.last ? result.last.alerts : []).slice();
      if (!result.latestAssistantHasDelta) alerts.push('Your last reply had no <delta> block. End this reply with one (or <delta></delta> if nothing changed).');
      const parts = LH.promptParts(result.state, alerts, { userText: typeof userText === 'string' ? userText : '' });
      injectPrompts([{
        id: SCAN_ID,           // short and scanned: loads the district and the entries of the people in the scene
        position: 'in_chat',
        depth: 0,
        role: 'system',
        content: parts.scan,
        should_scan: true,
      }, {
        id: INJECT_ID,
        position: 'in_chat',
        depth: 0,
        role: 'system',
        content: parts.state,
        should_scan: false,
      }]);
    }

    const parseCache = new Map();
    let ckptStore; // loaded lazily per chat
    let formStore = null;  // the create-a-resident form as last saved in this chat (photo, custom fields)
    let customList = [];   // custom townspeople and notes saved in this chat
    let opsStore = null;   // {id, tok, lines}: panel changes written into the latest narrator message
    let generating = false;
    let genAt = 0;
    const isGen = () => generating && Date.now() - genAt < 300000; // a stuck flag expires after five minutes
    let lastGreeting = '';
    let lastJson = '';
    let savedJson = '';

    async function recompute({ excludeLastAssistant = false, persist = true } = {}) {
      try {
        if (ckptStore === undefined) {
          try {
            const v = typeof getVariables === 'function' ? getVariables({ type: 'chat' }) : null;
            ckptStore = (v && v.larkhaven_ckpt) || null;
            formStore = (v && v.larkhaven_form && typeof v.larkhaven_form === 'object') ? v.larkhaven_form : null;
            customList = (v && Array.isArray(v.larkhaven_custom)) ? v.larkhaven_custom : [];
            opsStore = (v && v.larkhaven_ops && Array.isArray(v.larkhaven_ops.lines)) ? v.larkhaven_ops : null;
          } catch (e) { ckptStore = null; formStore = null; customList = []; opsStore = null; }
          LH.setCustom(customList);
        }
        const msgs = await readMessages(excludeLastAssistant);
        if (!isLarkhavenChat(msgs)) { goSilent(); return; }
        if (!excludeLastAssistant) await restoreOps(msgs);
        const result = LH.replay(msgs, parseCache, ckptStore);
        // while the reply that carried the panel's lines is being regenerated, the narrator still sees them
        if (excludeLastAssistant && opsStore && opsStore.id === msgCount - 1 && msgs.length === msgCount - 1) {
          try { LH.applyDelta(result.state, LH.parseDelta(opsStore.lines.join('\n'))); } catch (e) { /* state stays as replayed */ }
        }
        let lastUser = '';
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = typeof msgs[i].message === 'string' ? msgs[i].message : ''; break; }
        inject(result, lastUser);
        if (!excludeLastAssistant) {
          const json = JSON.stringify(result.state);
          const changed = json !== lastJson || !latest || latest.latestAssistantHasDelta !== result.latestAssistantHasDelta;
          latest = result;
          lastJson = json;
          if (changed) render(); // nothing new: leave the DOM alone
          if (!result.state.player.name && msgCount <= 1 && !casDismissed && !doc.getElementById(CAS_ID) && /Larkhaven|라크헤이븐/.test(lastGreeting)) setTimeout(casOpen, 600);
          if (persist && json !== savedJson) { // write the chat file only when the numbers changed
            try {
              const ck = result.ckpt && (!ckptStore || result.ckpt.tail !== ckptStore.tail || result.ckpt.len !== ckptStore.len) ? result.ckpt : null;
              await updateVariablesWith((vars) => { vars.larkhaven = result.state; if (ck) vars.larkhaven_ckpt = ck; return vars; }, { type: 'chat' });
              if (ck) ckptStore = ck;
              savedJson = json;
            } catch (e) { console.warn('[Larkhaven] could not save chat variables', e); }
          }
        }
        if (result.allWarnings.length) console.info('[Larkhaven] delta warnings', result.allWarnings);
      } catch (e) {
        console.error('[Larkhaven] recompute failed; keeping last good state', e);
        setNotice('계산 오류 — 콘솔(F12) 확인');
      }
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => recompute(), 150);
    }

    /* ---------- UI ---------- */

    function el(tag, cls, text) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }

    function ensureUI() {
      if (!doc.getElementById(STYLE_ID)) {
        const st = doc.createElement('style');
        st.id = STYLE_ID;
        st.textContent = `
#${UI_ID}{position:fixed;left:0;right:0;margin:0 auto;top:calc(var(--topBarBlockSize,40px) + 6px);
  z-index:3000;width:min(calc(100% - 12px),680px);box-sizing:border-box;display:flex;flex-direction:column;
  max-height:calc(100vh - var(--topBarBlockSize,40px) - 14px);max-height:calc(100dvh - var(--topBarBlockSize,40px) - 14px);font-size:13px;line-height:1.35;-webkit-tap-highlight-color:transparent;
  color:var(--SmartThemeBodyColor,#ddd);font-family:inherit;pointer-events:none}
#${UI_ID} .lh-bar,#${UI_ID} .lh-panel{pointer-events:auto;
  background:var(--SmartThemeBlurTintColor,rgba(20,20,24,.88));
  border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));
  border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.22)}
#${UI_ID} .lh-bar{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:6px 10px;cursor:pointer;user-select:none}
#${UI_ID} .lh-chip{white-space:nowrap}
#${UI_ID} .lh-money{font-weight:600}
#${UI_ID} .lh-thought{font-style:italic;font-size:12px;margin-top:3px;padding:4px 8px;border-radius:8px;background:rgba(217,106,138,.14)}
#${UI_ID} .lh-memos{font-size:11.5px;opacity:.85;margin-top:3px;display:flex;flex-direction:column;gap:1px}
#${UI_ID} .lh-needs{display:flex;gap:6px;flex:1 1 150px;min-width:150px}
#${UI_ID} .lh-need{flex:1;display:flex;flex-direction:column;gap:2px;font-size:11px;opacity:.9}
#${UI_ID} .lh-track{height:5px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden}
#${UI_ID} .lh-fill{height:100%;border-radius:3px;background:var(--SmartThemeQuoteColor,#7fb07f)}
#${UI_ID} .lh-fill.low{background:#d9822b}
#${UI_ID} .lh-fill.crit{background:#c94b4b}
#${UI_ID} .lh-notice{color:#e0a040;font-size:12px}
#${UI_ID} *{box-sizing:border-box}
#${UI_ID} .lh-bar{flex:0 0 auto}
#${UI_ID} .lh-panel{margin-top:6px;padding:10px 12px;flex:0 1 auto;min-height:0;max-height:640px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
#${UI_ID} .lh-panel img{max-width:100%}
#${UI_ID} .lh-panel h4{margin:8px 0 4px;font-size:12px;opacity:.75;font-weight:600}
#${UI_ID} .lh-panel h4:first-child{margin-top:0}
#${UI_ID} .lh-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
#${UI_ID} .lh-muted{opacity:.7}
#${UI_ID} .lh-warn{font-size:12px;color:#e0a040;word-break:break-word}
#${UI_ID} .lh-btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
#${UI_ID} button{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;
  color:inherit;background:rgba(127,127,127,.18);border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.2))}
#${UI_ID} .lh-tabs{display:flex;gap:6px;margin:0 -12px 8px;padding:0 12px 2px;overflow-x:auto;scrollbar-width:none;position:sticky;top:-10px;z-index:2;
  background:inherit}
#${UI_ID} .lh-tabs::-webkit-scrollbar{display:none}
#${UI_ID} .lh-tabs button{flex:0 0 auto;white-space:nowrap}
#${UI_ID} .lh-tabs button.on{background:var(--SmartThemeQuoteColor,#7fb07f);color:#111}
#${UI_ID} .lh-npc{padding:6px 0;border-top:1px solid rgba(127,127,127,.2)}
#${UI_ID} .lh-npc:first-of-type{border-top:0}
#${UI_ID} .lh-hearts{letter-spacing:2px}
#${UI_ID} .lh-fill.love{background:#d96a8a}
#${UI_ID} .lh-acts{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}
#${UI_ID} .lh-acts button{min-height:34px}
#${UI_ID} button:disabled{opacity:.4;cursor:not-allowed}
#${UI_ID} button.on{background:var(--SmartThemeQuoteColor,#7fb07f);color:#111}
#${UI_ID} .lh-npcs{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0}
#${UI_ID} .lh-note{font-size:11.5px;opacity:.7;margin:2px 0 6px}
#${UI_ID} .lh-map{position:relative;height:220px;border-radius:10px;overflow:hidden;background:linear-gradient(#6fa9cf,#4f8db8);margin:4px 0 8px;border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.2))}
#${UI_ID} .lh-map .land{position:absolute;left:0;top:0;right:0;height:72%;background:#8fb36a;border-radius:0 0 50% 40%/0 0 22% 18%}
#${UI_ID} .lh-map .z{position:absolute;border-radius:12px;opacity:.85}
#${UI_ID} .lh-map .pier{position:absolute;left:14%;top:76%;width:34%;height:6%;background:#8a5a2b;border-radius:3px}
#${UI_ID} .lh-map .me{position:absolute;transform:translate(-50%,-50%);width:36px;height:36px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);background:#d96a8a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;overflow:hidden;z-index:3;pointer-events:none}
#${UI_ID} .lh-map .me img{width:100%;height:100%;object-fit:cover;object-position:50% 20%}
#${UI_ID} .lh-me{display:flex;gap:10px;align-items:center;margin:4px 0 6px}
#${UI_ID} .lh-me img{width:64px;height:64px;border-radius:12px;object-fit:cover;object-position:50% 20%}
#${UI_ID} .lh-map .cannery{position:absolute;left:68%;top:6%;font-size:18px;opacity:.85}
#${UI_ID} .lh-map button.d{position:absolute;transform:translate(-50%,-50%);min-height:0;padding:3px 8px;border-radius:14px;font-size:12px;line-height:1.3;white-space:nowrap;
  background:rgba(20,20,24,.78);color:#fff;border:1px solid rgba(255,255,255,.35)}
#${UI_ID} .lh-map button.d.sel{background:#f3d98a;color:#3a2a14;border-color:#8b5a2b;font-weight:700}
#${UI_ID} .lh-pcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px}
#${UI_ID} .lh-pc{display:flex;gap:8px;align-items:flex-start;padding:6px;border-radius:10px;background:rgba(127,127,127,.12)}
#${UI_ID} .lh-pc img,#${UI_ID} .lh-pc .av{width:58px;height:58px;border-radius:10px;object-fit:cover;object-position:50% 20%;flex:0 0 58px}
#${UI_ID} .lh-pc .av{display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff}
#${UI_ID} .lh-pc .t{font-size:12px;line-height:1.45;min-width:0}
#${UI_ID} .lh-pc .t b{font-size:13px}
#${UI_ID} .lh-q{padding:8px 10px;border-radius:10px;background:rgba(127,127,127,.12);margin:6px 0}
#${UI_ID} .lh-q.done{opacity:.6}
#${UI_ID} .lh-q .who{font-size:11.5px;opacity:.75}
#${UI_ID} input.lh-in{width:100%;font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;background:rgba(127,127,127,.15);color:inherit;border:1px solid rgba(127,127,127,.4)}
@media (max-width:600px){
  #${UI_ID}{font-size:14px;width:calc(100% - 8px)}
  #${UI_ID} button{min-height:38px;padding:6px 12px;font-size:13px}
  #${UI_ID} .lh-tabs button{min-height:34px;padding:4px 10px}
  #${UI_ID} .lh-panel{max-height:none;padding:10px}
  #${UI_ID} .lh-bar{gap:3px 8px;padding:5px 8px;font-size:12.5px}
  #${UI_ID} .lh-needs{flex:1 1 100%;min-width:0}
  #${UI_ID} .lh-tabs{margin:0 -10px 8px;padding:0 10px 2px}
  #${UI_ID} .lh-pcs{grid-template-columns:1fr}
  #${UI_ID} .lh-map{height:200px}
  #${UI_ID} .lh-map button.d{font-size:11px;padding:2px 6px}
  #${UI_ID} .lh-row{flex-wrap:wrap}
  #${UI_ID} input.lh-in{font-size:16px}
}
@media (min-width:900px){
  #${UI_ID} .lh-map{height:250px}
}
@media (prefers-reduced-motion:reduce){#${UI_ID} *{transition:none !important}}
#${UI_ID} .lh-room{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:6px 0}
#${UI_ID} .lh-cell{border:1px dashed rgba(127,127,127,.5);border-radius:6px;min-height:52px;padding:3px 2px;text-align:center;font-size:11px;line-height:1.25;display:flex;flex-direction:column;justify-content:center}
#${UI_ID} .lh-cell.empty{opacity:.45}
#${UI_ID} .lh-cell i{font-style:normal;font-size:20px;line-height:1.1}
#${UI_ID} .lh-ok{color:#7fb07f;font-weight:600}
@media (max-width:600px){#${UI_ID} .lh-room{grid-template-columns:repeat(3,1fr)}}
#${UI_ID} .lh-seg{display:flex;gap:4px;margin:2px 0 10px;padding:3px;border-radius:10px;background:rgba(127,127,127,.14);overflow-x:auto;scrollbar-width:none}
#${UI_ID} .lh-seg::-webkit-scrollbar{display:none}
#${UI_ID} .lh-seg button{flex:1 0 auto;border:0;background:transparent;border-radius:8px;white-space:nowrap}
#${UI_ID} .lh-seg button.on{background:var(--SmartThemeQuoteColor,#7fb07f);color:#111;font-weight:700}
#${UI_ID} .lh-card{padding:8px 10px;border-radius:10px;background:rgba(127,127,127,.10);margin:0 0 8px}
#${UI_ID} .lh-card>h4{margin:0 0 6px!important}
#${UI_ID} .lh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px}
#${UI_ID} .lh-grid button{min-height:36px;text-align:center;white-space:normal;line-height:1.25}
#${UI_ID} .lh-pill{display:flex;flex-wrap:wrap;gap:5px}
#${UI_ID} .lh-pill button{border-radius:999px;padding:3px 11px}
`;
        doc.head.appendChild(st);
      }
      let root = doc.getElementById(UI_ID);
      if (!root) {
        root = el('div');
        root.id = UI_ID;
        doc.body.appendChild(root);
      }
      return root;
    }

    let noticeText = '';
    let noticeTimer = null;
    function setNotice(t, ms) {
      noticeText = t;
      clearTimeout(noticeTimer);
      if (ms) noticeTimer = setTimeout(() => { noticeText = ''; render(); }, ms);
      render();
    }

    // Put text in SillyTavern's input box (and optionally press send).
    function setInput(text, send) {
      const ta = doc.getElementById('send_textarea');
      if (!ta) { setNotice('입력창을 찾지 못했어요', 5000); return false; }
      ta.value = text;
      try {
        const Ev = (doc.defaultView && doc.defaultView.Event) || Event;
        ta.dispatchEvent(new Ev('input', { bubbles: true }));
        ta.focus();
      } catch (e) { /* the text is in the box either way */ }
      if (send) {
        const b = doc.getElementById('send_but');
        if (b) b.click();
        else setNotice('보내기 버튼을 찾지 못했어요', 5000);
      }
      return true;
    }

    function needBar(label, v) {
      const wrap = el('div', 'lh-need');
      wrap.appendChild(el('span', '', `${label} ${v}`));
      const track = el('div', 'lh-track');
      const fill = el('div', 'lh-fill' + (v <= 15 ? ' crit' : v <= 35 ? ' low' : ''));
      fill.style.width = `${v}%`;
      track.appendChild(fill);
      wrap.appendChild(track);
      return wrap;
    }

    function row(parent, k, v) {
      const r = el('div', 'lh-row');
      r.appendChild(el('span', 'lh-muted', k));
      r.appendChild(el('span', '', v));
      parent.appendChild(r);
    }

    function barRow(parent, label, value, pct, cls) {
      const r = el('div', 'lh-row');
      r.appendChild(el('span', '', label));
      r.appendChild(el('span', 'lh-muted', value));
      parent.appendChild(r);
      const track = el('div', 'lh-track');
      const fill = el('div', 'lh-fill' + (cls ? ` ${cls}` : ''));
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      track.appendChild(fill);
      parent.appendChild(track);
    }

    function renderGrowth(p, s) {
      p.appendChild(el('h4', '', '기술'));
      for (const id of Object.keys(s.skills)) {
        const k = s.skills[id];
        const need = LH.skillNeed(k.level);
        const perk = s.perks[id] ? ` · ${KO.perk[s.perks[id]] || s.perks[id]}` : '';
        if (k.level >= 10) barRow(p, `${KO.skill[id]} Lv 10 (최대)${perk}`, 'MAX', 100);
        else barRow(p, `${KO.skill[id]} Lv ${k.level}${perk}`, `${k.xp}/${need}`, (k.xp / need) * 100);
      }
      for (const id of s.pendingPerks) {
        p.appendChild(el('div', 'lh-warn', `⭐ ${KO.skill[id]} 5레벨: 퍽을 고를 수 있어요 (${LH.SKILL_PERKS[id].map((x) => KO.perk[x]).join(' / ')})`));
      }

      p.appendChild(el('h4', '', '직업'));
      const cur = s.career.current;
      if (!cur) {
        p.appendChild(el('div', 'lh-muted', '무직 — 언제든 구할 수 있어요.'));
      } else {
        const tr = s.career.tracks[cur];
        row(p, '직장', `${KO.track[cur]} · ${LH.CAREER[cur].titles[tr.level - 1]} (Lv ${tr.level})`);
        row(p, '월급', cur === 'freelance' ? '건당 $18 + 기술 레벨당 $2' : `교대 1회 $${LH.CAREER_PAY[tr.level]}`);
        row(p, '오늘', LH.shiftToday(s) ? '근무 가능' : '근무 없음');
        const g = LH.promotionGates(s);
        if (g) {
          p.appendChild(el('h4', '', `승진 조건 → ${g.next_title}`));
          barRow(p, '경력 XP', `${g.career_xp.have}/${g.career_xp.need}`, (g.career_xp.have / g.career_xp.need) * 100, g.career_xp.have >= g.career_xp.need ? 'love' : '');
          row(p, `${g.skill.ids.map((x) => KO.skill[x]).join('/')} 레벨`, `${g.skill.have}/${g.skill.need} ${g.skill.have >= g.skill.need ? '✓' : ''}`);
          if (g.mentor) row(p, `멘토 호감도 (${LH.KO_NAME[g.mentor.id]})`, `${g.mentor.have}/${g.mentor.need} ${g.mentor.have >= g.mentor.need ? '✓' : ''}`);
          p.appendChild(el('div', 'lh-muted', '조건이 모두 차면 하루가 끝날 때 자동 승진해요.'));
        } else if (cur !== 'freelance') {
          p.appendChild(el('div', 'lh-muted', '최고 직급이에요.'));
        }
      }
      const others = Object.entries(s.career.tracks).filter(([id, t]) => id !== cur && (t.xp > 0 || t.level > 1));
      if (others.length) {
        p.appendChild(el('h4', '', '다른 직업 기록'));
        for (const [id, t] of others) row(p, KO.track[id], `Lv ${t.level} · ${t.xp} XP`);
      }
    }

    function fire(a) {
      const text = settings.lang === 'ko' ? a.textKo : a.textEn;
      const sent = setInput(text, settings.autoSend);
      if (sent) {
        if (settings.closeAfter) panelOpen = false;
        setNotice(settings.autoSend ? '보냈어요' : '입력창에 넣었어요 — 보내기를 눌러 주세요', 3500);
      }
    }

    function actButton(parent, a) {
      const b = el('button', '', settings.lang === 'ko' ? a.ko : a.en);
      b.disabled = !a.enabled;
      b.title = a.enabled ? (settings.lang === 'ko' ? a.textKo : a.textEn) : a.note;
      b.addEventListener('click', (e) => { e.stopPropagation(); fire(a); });
      parent.appendChild(b);
    }

const actExtra = {}; // what the player typed under each group, added to the sentence
    let socTarget = null;
    let socCat = 'friendly';
    const SOC_CATS = [['friendly', '😊 친근하게'], ['funny', '😂 재밌게'], ['romantic', '💗 로맨틱'], ['mean', '😈 야비하게'], ['mischief', '🃏 장난']];
    // [label, Korean sentence, English sentence]; {n} = the person
    const SOC = {
      friendly: [['인사하기', '{n}에게 반갑게 인사를 건넨다', 'I greet {n} warmly'], ['안부 묻기', '{n}에게 요즘 어떻게 지내는지 묻는다', 'I ask {n} how they have been'],
        ['칭찬하기', '{n}에게 진심 어린 칭찬을 한다', 'I give {n} a sincere compliment'], ['취미 묻기', '{n}에게 좋아하는 것과 취미를 묻는다', 'I ask {n} about their hobbies'],
        ['하루 일과 묻기', '{n}에게 오늘 하루가 어땠는지 묻는다', 'I ask {n} about their day'], ['고민 들어주기', '{n}의 고민을 가만히 들어 준다', "I listen to what is weighing on {n}"],
        ['내 얘기 털어놓기', '{n}에게 내 속 얘기를 조금 털어놓는다', 'I open up to {n} about myself'], ['마을 소문 나누기', '{n}와(과) 마을 소문을 주고받는다', 'I trade town gossip with {n}'],
        ['밥 먹자고 하기', '{n}에게 같이 밥을 먹자고 한다', 'I ask {n} to eat with me'], ['같이 걷자고 하기', '{n}에게 잠깐 같이 걷자고 한다', 'I ask {n} to walk with me for a while'],
        ['고마움 전하기', '{n}에게 고맙다고 말한다', 'I thank {n}'], ['사과하기', '{n}에게 진심으로 사과한다', 'I apologize to {n} and mean it'],
        ['위로하기', '{n}을(를) 위로한다', 'I comfort {n}'], ['포옹하기', '{n}을(를) 가볍게 안아 준다', 'I give {n} a friendly hug'], ['하이파이브', '{n}와(과) 하이파이브를 한다', 'I high-five {n}']],
      funny: [['농담하기', '{n}에게 농담을 던진다', 'I tell {n} a joke'], ['웃긴 얘기 하기', '{n}에게 최근에 있었던 웃긴 일을 들려준다', 'I tell {n} a funny story'],
        ['아재개그', '{n}에게 썰렁한 말장난을 친다', 'I try a terrible pun on {n}'], ['성대모사', '{n} 앞에서 마을 사람 흉내를 낸다', 'I do an impression of someone in town for {n}'],
        ['가볍게 놀리기', '{n}을(를) 악의 없이 놀린다', 'I tease {n} playfully'], ['웃긴 표정 짓기', '{n}에게 웃긴 표정을 지어 보인다', 'I pull a silly face at {n}'],
        ['내 흑역사 얘기', '{n}에게 내 창피한 과거 얘기를 해 준다', 'I tell {n} an embarrassing story about myself'], ['같이 웃기', '{n}와(과) 별것 아닌 일로 한참 웃는다', 'I laugh with {n} over nothing much']],
      romantic: [['눈 맞추기', '{n}와(과) 눈을 맞추고 피하지 않는다', "I hold {n}'s gaze"], ['플러팅', '{n}에게 은근히 플러팅을 한다', 'I flirt with {n}'],
        ['외모 칭찬', '{n}에게 오늘 멋지다고 말한다', 'I tell {n} how good they look today'], ['은근슬쩍 닿기', '{n}의 손에 은근슬쩍 손을 스친다', "I let my hand brush {n}'s"],
        ['손잡기', '{n}의 손을 잡는다', "I take {n}'s hand"], ['귓속말하기', '{n}의 귀에 대고 속삭인다', "I whisper in {n}'s ear"],
        ['데이트 신청', '{n}에게 데이트를 신청한다', 'I ask {n} out on a date'], ['별 보러 가자고 하기', '{n}에게 같이 별을 보러 가자고 한다', 'I ask {n} to go stargazing with me'],
        ['꽃 건네기', '{n}에게 꽃 한 송이를 건넨다', 'I hand {n} a flower'], ['어깨에 기대기', '{n}의 어깨에 살며시 기댄다', "I lean on {n}'s shoulder"],
        ['껴안기', '{n}을(를) 끌어안는다', 'I pull {n} into an embrace'], ['볼에 입맞추기', '{n}의 볼에 입을 맞춘다', 'I kiss {n} on the cheek'],
        ['키스하기', '{n}에게 키스한다', 'I kiss {n}'], ['마음 고백하기', '{n}에게 좋아한다고 고백한다', 'I tell {n} how I feel about them'], ['사귀자고 하기', '{n}에게 사귀자고 말한다', 'I ask {n} to be mine']],
      mean: [['비꼬기', '{n}에게 비꼬는 말을 한다', 'I make a sarcastic dig at {n}'], ['무시하기', '{n}을(를) 대놓고 무시한다', 'I pointedly ignore {n}'],
        ['모욕하기', '{n}을(를) 모욕한다', 'I insult {n}'], ['약점 건드리기', '{n}의 아픈 곳을 일부러 건드린다', "I press on {n}'s sore spot on purpose"],
        ['시비 걸기', '{n}에게 시비를 건다', 'I pick a fight with {n}'], ['말싸움하기', '{n}와(과) 언성을 높여 다툰다', 'I get into a shouting match with {n}'],
        ['험담 퍼뜨리기', '{n}에 대한 험담을 마을에 흘린다', 'I spread nasty talk about {n} around town'], ['사과 요구하기', '{n}에게 사과하라고 요구한다', 'I demand an apology from {n}'],
        ['차갑게 굴기', '{n}에게 차갑게 군다', 'I give {n} the cold shoulder'], ['절교 선언', '{n}에게 다시는 보지 말자고 한다', 'I tell {n} we are done']],
      mischief: [['깜짝 놀래키기', '{n}을(를) 뒤에서 깜짝 놀래킨다', 'I sneak up and startle {n}'], ['간지럽히기', '{n}을(를) 간지럽힌다', 'I tickle {n}'],
        ['물건 숨기기', '{n}의 물건을 몰래 숨겨 놓는다', "I hide something of {n}'s"], ['장난 거짓말', '{n}에게 그럴듯한 거짓말로 장난을 친다', 'I fool {n} with a convincing little lie'],
        ['몰래 따라가기', '{n}을(를) 몰래 따라가 본다', 'I quietly follow {n} to see where they go'], ['엿듣기', '{n}의 대화를 몰래 엿듣는다', "I eavesdrop on {n}"],
        ['내기 걸기', '{n}에게 엉뚱한 내기를 건다', 'I dare {n} into a silly bet'], ['별명 붙이기', '{n}에게 우스운 별명을 붙여 부른다', 'I give {n} a ridiculous nickname']],
    };
    function fireText(text, group) {
      const extra = String(actExtra[group] || '').replace(/\s+/g, ' ').trim();
      const full = `${text.replace(/[.\s]+$/, '')}.${extra ? ` ${extra}` : ''}`;
      const sent = setInput(full, settings.autoSend);
      if (sent) {
        if (settings.closeAfter) panelOpen = false;
        setNotice(settings.autoSend ? '보냈어요' : '입력창에 넣었어요 — 보내기를 눌러 주세요', 3500);
        render();
      }
    }
    function extraInput(parent, group, ph) {
      const i = el('input', 'lh-in');
      i.placeholder = ph || '덧붙일 말 (선택): 버튼을 누르면 문장 뒤에 붙어요';
      i.value = actExtra[group] || '';
      i.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 6px;padding:6px 8px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,rgba(127,127,127,.4));background:rgba(127,127,127,.12);color:inherit;font:inherit;font-size:12.5px';
      i.addEventListener('click', (e) => e.stopPropagation());
      i.addEventListener('input', () => { actExtra[group] = i.value; });
      parent.appendChild(i);
    }
    let actTab = 'social';
    function renderSocial(p, s) {
      const scn = (s.scene || []).filter((id) => LH.NPC_DATA[id]);
      const here = LH.peopleHere(s);
      const ids = [...new Set([...scn, ...here.filter((x) => x.spot === s.place.spot).map((x) => x.id), ...here.map((x) => x.id)])];
      const nameOf = (id) => {
        const known = s.npc[id].met || s.affinity[id] > 0;
        return settings.lang === 'ko' ? (known ? LH.KO_NAME[id] : LH.ROLE[id][0]) : (known ? LH.firstName(id) : LH.ROLE[id][1]);
      };
      if (socTarget && socTarget !== '*' && !ids.includes(socTarget)) socTarget = null;
      if (!socTarget) socTarget = ids[0] || '*';
      const c1 = el('div', 'lh-card');
      c1.appendChild(el('h4', '', '① 누구에게'));
      const tw = el('div', 'lh-pill');
      for (const id of ids) {
        const b = el('button', socTarget === id ? 'on' : '', `${scn.includes(id) || here.some((x) => x.id === id && x.spot === s.place.spot) ? '● ' : ''}${nameOf(id)}`);
        b.title = '● 는 지금 같은 자리에 있는 사람이에요';
        b.addEventListener('click', (e) => { e.stopPropagation(); socTarget = id; render(); });
        tw.appendChild(b);
      }
      const ob = el('button', socTarget === '*' ? 'on' : '', '✏️ 다른 사람');
      ob.addEventListener('click', (e) => { e.stopPropagation(); socTarget = '*'; render(); });
      tw.appendChild(ob);
      c1.appendChild(tw);
      if (socTarget === '*') extraInput(c1, 'socName', '상대 이름을 적어 주세요 (예: 홀든, 지나가던 관광객)');
      p.appendChild(c1);
      const c2 = el('div', 'lh-card');
      c2.appendChild(el('h4', '', '② 어떤 분위기로'));
      const cw = el('div', 'lh-seg');
      for (const [k, label] of SOC_CATS) {
        const b = el('button', socCat === k ? 'on' : '', label);
        b.addEventListener('click', (e) => { e.stopPropagation(); socCat = k; render(); });
        cw.appendChild(b);
      }
      c2.appendChild(cw);
      const target = () => (socTarget === '*' ? (String(actExtra.socName || '').trim() || (settings.lang === 'ko' ? '그 사람' : 'them')) : nameOf(socTarget));
      const fill = (tpl) => { // Korean particles follow the last letter of the name
        const n = target();
        const c = n.charCodeAt(n.length - 1);
        const hangul = c >= 0xAC00 && c <= 0xD7A3;
        const batchim = hangul && (c - 0xAC00) % 28 !== 0;
        let t = tpl;
        if (hangul) t = t.replace('{n}을(를)', `{n}${batchim ? '을' : '를'}`).replace('{n}와(과)', `{n}${batchim ? '과' : '와'}`);
        return t.replace('{n}', n);
      };
      const say = (it) => fireText(fill(settings.lang === 'ko' ? it[1] : it[2]), 'social');
      const box = el('div', 'lh-grid');
      for (const it of SOC[socCat]) {
        const b = el('button', '', it[0]);
        b.title = fill(settings.lang === 'ko' ? it[1] : it[2]);
        b.addEventListener('click', (e) => { e.stopPropagation(); say(it); });
        box.appendChild(b);
      }
      c2.appendChild(box);
      if (socCat === 'romantic') c2.appendChild(el('div', 'lh-note', '지금 관계 단계에 따라 받아줄 수도, 밀어낼 수도 있어요. 거절당하는 것도 이야기예요.'));
      if (socCat === 'mean') c2.appendChild(el('div', 'lh-note', '못되게 굴면 호감도가 떨어지고 상대가 오래 기억해요.'));
      p.appendChild(c2);
      const c3 = el('div', 'lh-card');
      c3.appendChild(el('h4', '', '③ 덧붙이기 · 랜덤'));
      extraInput(c3, 'social', '덧붙일 말 (선택). 예: 눈을 못 마주치고 말끝을 흐리며');
      const rw = el('div', 'lh-pill');
      const r1 = el('button', '', '🎲 이 분위기에서 랜덤');
      r1.addEventListener('click', (e) => { e.stopPropagation(); say(SOC[socCat][Math.floor(Math.random() * SOC[socCat].length)]); });
      rw.appendChild(r1);
      const r2 = el('button', '', '🎲 완전 랜덤');
      r2.addEventListener('click', (e) => { e.stopPropagation(); const all = Object.values(SOC).flat(); say(all[Math.floor(Math.random() * all.length)]); });
      rw.appendChild(r2);
      c3.appendChild(rw);
      p.appendChild(c3);
    }

    function renderActions(p, s) {
      const TABS = [['social', '💬 사교'], ['move', '🚶 이동'], ['needs', '🍽️ 몸과 마음'], ['work', '💼 일 · 기술'], ['home', '🏠 집']];
      const seg = el('div', 'lh-seg');
      for (const [k, label] of TABS) {
        const b = el('button', actTab === k ? 'on' : '', label);
        b.addEventListener('click', (e) => { e.stopPropagation(); actTab = k; render(); });
        seg.appendChild(b);
      }
      p.appendChild(seg);
      if (actTab === 'social') { renderSocial(p, s); }
      else {
        const all = LH.buildActions(s).filter((a) => !['rearrange', 'shop', 'upgrade'].includes(a.key)); // those happen instantly in the 🏠 tab now
        const groups = actTab === 'work' ? [['work', '일'], ['practice', '기술 연습']] : [[actTab, (TABS.find((t) => t[0] === actTab) || ['', ''])[1].replace(/^\S+\s/, '')]];
        for (const [g, label] of groups) {
          const list = all.filter((a) => a.group === g);
          if (!list.length) continue;
          const card = el('div', 'lh-card');
          card.appendChild(el('h4', '', label));
          const box = el('div', 'lh-grid');
          for (const a of list) {
            const b = el('button', '', settings.lang === 'ko' ? a.ko : a.en);
            b.disabled = !a.enabled;
            b.title = a.enabled ? (settings.lang === 'ko' ? a.textKo : a.textEn) : a.note;
            b.addEventListener('click', (e) => { e.stopPropagation(); fireText(settings.lang === 'ko' ? a.textKo : a.textEn, actTab); });
            box.appendChild(b);
          }
          card.appendChild(box);
          p.appendChild(card);
        }
        const ex = el('div', 'lh-card');
        ex.appendChild(el('h4', '', '덧붙이기'));
        extraInput(ex, actTab, '덧붙일 말 (선택). 버튼을 누르면 문장 뒤에 붙어요');
        p.appendChild(ex);
        if (actTab === 'home') p.appendChild(el('div', 'lh-note', '가구 구매 · 배치 · 집 확장은 위의 🏠 집 탭에서 AI 답변 없이 바로 할 수 있어요.'));
      }
      p.appendChild(el('div', 'lh-note', settings.autoSend ? '누르면 바로 전송돼요. (⚙️ 설정에서 바꿀 수 있어요)' : '누르면 입력창에 문장이 들어가요. 고치거나 덧붙인 뒤 보내세요.'));
    }

    function toggleRow(p, label, value, onClick) {
      const r = el('div', 'lh-row');
      r.appendChild(el('span', '', label));
      const b = el('button', '', value);
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); saveSettings(); render(); });
      r.appendChild(b);
      p.appendChild(r);
    }

    async function copyState() {
      const text = JSON.stringify({ script: 'Larkhaven v3.0', state: latest ? latest.state : null, recentWarnings: latest ? latest.allWarnings.slice(-5) : [] }, null, 1);
      try {
        await window.parent.navigator.clipboard.writeText(text);
        setNotice('상태를 복사했어요', 3000);
      } catch (e) {
        setNotice('복사가 막혀 있어요 — 아래 상자에서 직접 복사하세요');
        copyFallback = text;
        render();
      }
    }
    let copyFallback = '';

    function renderSettings(p, s) {
      p.appendChild(el('h4', '', '행동 메뉴'));
      toggleRow(p, '입력 문장 언어', settings.lang === 'ko' ? '한국어' : 'English', () => { settings.lang = settings.lang === 'ko' ? 'en' : 'ko'; });
      toggleRow(p, '누르면 바로 전송', settings.autoSend ? '켜짐' : '꺼짐', () => { settings.autoSend = !settings.autoSend; });
      toggleRow(p, '누른 뒤 창 닫기', settings.closeAfter ? '켜짐' : '꺼짐', () => { settings.closeAfter = !settings.closeAfter; });
      p.appendChild(el('h4', '', '상태바'));
      const modes = { full: '전체', compact: '간단', min: '최소' };
      toggleRow(p, '크기', modes[settings.barMode], () => { settings.barMode = settings.barMode === 'full' ? 'compact' : settings.barMode === 'compact' ? 'min' : 'full'; });
      p.appendChild(el('div', 'lh-note', '전체: 욕구 게이지 포함 · 간단: 게이지 없음 · 최소: 날짜와 돈만'));
      p.appendChild(el('h4', '', '주민 이미지'));
      p.appendChild(el('div', 'lh-note', '이미지 폴더 주소를 넣으면 그 안의 damon.png, julius.png … 를 찾아요. 주민마다 주소를 따로 넣을 수도 있어요. 비워 두면 이니셜이 보여요.'));
      const base = el('input', 'lh-in');
      base.placeholder = '예: https://…/larkhaven/  또는  /user/images/Larkhaven/';
      base.value = settings.imgBase;
      base.addEventListener('change', () => { settings.imgBase = base.value.trim(); saveSettings(); render(); });
      base.addEventListener('click', (e) => e.stopPropagation());
      p.appendChild(base);
      const ext = el('button', '', `확장자 ${settings.imgExt}`);
      ext.addEventListener('click', (e) => { e.stopPropagation(); const L = ['.png', '.jpg', '.webp']; settings.imgExt = L[(L.indexOf(settings.imgExt) + 1) % L.length]; saveSettings(); render(); });
      p.appendChild(ext);
      for (const id of LH.NPCS) {
        const r = el('div', 'lh-row');
        r.appendChild(el('span', '', id));
        const inp = el('input', 'lh-in');
        inp.style.width = '70%';
        inp.placeholder = '개별 이미지 주소 (선택)';
        inp.value = (settings.img && settings.img[id]) || '';
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('change', () => { settings.img = { ...(settings.img || {}), [id]: inp.value.trim() }; saveSettings(); render(); });
        r.appendChild(inp);
        p.appendChild(r);
      }
      p.appendChild(el('h4', '', '진단'));
      row(p, '반영된 답변 수', String(latest.applied));
      const lastWarn = latest.allWarnings.slice(-3);
      if (!lastWarn.length) p.appendChild(el('div', 'lh-muted', '경고 없음'));
      for (const w of lastWarn) p.appendChild(el('div', 'lh-warn', `#${w.id}: ${w.warnings.join(' / ')}`));
      const btns = el('div', 'lh-acts');
      const copy = el('button', '', '상태 복사 (오류 제보용)');
      copy.addEventListener('click', (e) => { e.stopPropagation(); copyState(); });
      btns.appendChild(copy);
      p.appendChild(btns);
      if (copyFallback) {
        const ta = el('textarea');
        ta.value = copyFallback;
        ta.readOnly = true;
        ta.style.cssText = 'width:100%;height:110px;font-size:11px';
        p.appendChild(ta);
      }
      p.appendChild(el('div', 'lh-note', '설정은 이 브라우저에만 저장돼요. 게임 수치는 채팅 기록에서 계산되므로 따로 저장하지 않아요.'));
    }

    const ACT = {
      ashcroft_store: '🏬 백화점에 있어요', store_office: '🗂️ 사장실에서 일하는 중', rourke_office: '📈 사무실에서 회의 중', nocturne_bar: '🍸 루프탑 바에 있어요',
      construction_site: '🏗️ 공사장을 둘러보는 중', clinic: '🩺 병원에 있어요', town_square: '⛲ 광장에 나와 있어요', rooftop_terrace: '🎆 옥상 테라스에 있어요',
      old_mill_market: '🧺 시장에 나와 있어요', sakaki_pottery: '🏺 공방에 있어요', finch_teahouse: '🫖 찻집에 있어요', street_stage: '🎩 거리 무대 근처에 있어요',
      flower_shop: '💐 꽃집에 있어요', mercer_farm: '🚜 밭일 중', hale_farm: '🌱 밭을 돌보는 중', orchard: '🍎 과수원에 있어요', pond: '🎣 연못가에 있어요',
      fairground: '🎪 축제장에 있어요', salty_whisker: '🍲 카페에 있어요', fish_market: '🐟 어시장에 있어요', food_stalls: '🏮 포장마차 거리에 있어요',
      lighthouse: '🗼 등대 근처에 있어요', beach: '🏖️ 해변을 걷는 중', pier: '⚓ 부두에 있어요', windmill: '🌬️ 풍차 근처에 있어요',
      sunflower_field: '🌻 해바라기 밭에 있어요', glass_greenhouse: '🧪 온실에 있어요', stargazing_rock: '✨ 별을 보는 중', hill_maze: '🎃 미로 근처에 있어요',
      festival: '🎉 축제를 즐기는 중',
    };
    const ACT_NPC = {
      'damon/ashcroft_store': '🕴️ 매장을 순시하는 중', 'damon/store_office': '🗂️ 서류를 넘기는 중', 'damon/pier': '🐈 고양이를 멀찍이서 보는 중 (재채기 참는 중)',
      'julius/rourke_office': '📞 웃으며 협박 전화 중', 'julius/ashcroft_store': '🤝 백화점 사람들을 쥐락펴락하는 중', 'julius/nocturne_bar': '🥃 위스키를 기울이는 중',
      'julius/finch_teahouse': '♟️ 하워드 할아버지와 체스 중 (시장 사람들이 숨죽여요)', 'julius/salty_whisker': '🍲 구석에서 해물 스튜를 먹는 중',
      'callum/construction_site': '📐 도면을 보며 한숨 쉬는 중', 'callum/salty_whisker': '🥛 따뜻한 우유를 마시는 중', 'callum/pier': '✏️ 잠 못 들고 스케치하는 중',
      'callum/old_mill_market': '🪵 공방 맞은편 벤치에 혼자 앉아 있어요', 'celeste/ashcroft_store': '📸 촬영 준비 중', 'celeste/town_square': '💅 사람들 시선을 즐기는 중',
      'celeste/nocturne_bar': '🍓 딸기우유를 들고 있는 중', 'celeste/finch_teahouse': '🥧 (부엌에서 뭘 굽는 냄새가 나요, 찻집 구석은 비어 있어요)',
      'fabian/street_stage': '🎩 마술 공연 중', 'fabian/old_mill_market': '🪙 야바위판을 벌이는 중', 'fabian/food_stalls': '🥃 싸구려 위스키를 마시는 중',
      'fabian/glass_greenhouse': '🃏 베스퍼와 카드 치는 중', 'holden/sakaki_pottery': '🏺 물레를 돌리는 중', 'holden/old_mill_market': '🧺 그릇 가판대를 지키는 중',
      'holden/sunflower_field': '🐇 손바닥 위 아기 토끼에게 굳어 있는 중', 'garrett/mercer_farm': '🪓 장작을 패는 중', 'garrett/hale_farm': '🔨 로언네 울타리를 고치는 중',
      'garrett/old_mill_market': '🔧 가게 지붕을 고치는 중', 'garrett/clinic': '🦵 무릎 진료 중', 'garrett/pond': '🐕 버터와 낚시 중',
      'rowan/hale_farm': '🍅 작물에게 말을 거는 중', 'rowan/orchard': '🍎 사과를 따는 중', 'rowan/old_mill_market': '🥕 채소 가판대를 지키는 중',
      'rowan/sunflower_field': '😴 해바라기 사이에서 낮잠 중', 'rowan/salty_whisker': '🧺 채소를 배달하는 중', 'sasha/salty_whisker': '🔪 주방에서 요리하는 중',
      'sasha/fish_market': '🐟 생선을 고르는 중', 'sasha/pier': '🌅 막대사탕을 물고 노을을 보는 중', 'jett/town_square': '🏍️ 오토바이에 기대 있는 중',
      'jett/food_stalls': '🍜 컵라면을 먹는 중', 'jett/salty_whisker': '🌙 카페 위층 불이 켜져 있어요', 'vesper/glass_greenhouse': '🌿 약초를 다루는 중',
      'vesper/sunflower_field': '☀️ 햇볕 아래 조는 중', 'vesper/stargazing_rock': '✨ 별을 세는 중', 'vesper/old_mill_market': '🧴 향수 가판대를 지키는 중',
      'howard/finch_teahouse': '♟️ 체스판을 닦는 중', 'howard/pond': '🎣 연못에서 낚시 중', 'mabel/finch_teahouse': '🍋 레몬 타르트를 굽는 중',
      'mabel/flower_shop': '💐 꽃을 고르는 중', 'nell/windmill': '🌬️ 풍차 날개를 살피는 중', 'nell/food_stalls': '🍢 어묵을 먹으며 수다 중',
      'maggie/store_office': '📋 무표정하게 일정을 정리하는 중', 'maggie/finch_teahouse': '🥧 레몬 타르트를 포장해 가는 중 (사장 심부름)',
      'pip/old_mill_market': '📰 신문을 돌리는 중', 'pip/street_stage': '👀 파비앙의 공연을 보는 중', 'pip/pond': '🐸 개구리를 쫓는 중',
      'gus/pier': '🎣 낚싯대를 드리운 중', 'gus/fish_market': '🐟 생선을 파는 중', 'gus/food_stalls': '🍶 옛날 얘기를 하는 중',
      'ada/clinic': '🩺 진료 중', 'ada/nocturne_bar': '🍷 혼자 와인을 마시는 중', 'bea/flower_shop': '💐 꽃다발을 만드는 중', 'bea/beach': '🐚 조개를 줍는 중',
    };
    const COLORS = ['#c0705a', '#6f9a45', '#4f8db8', '#9a6fb0', '#c9a03a', '#5aa39a', '#b05a7a'];

    const okUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim());
    // The active persona's picture, read from the SillyTavern page (the persona list, else the latest user message).
    function personaAvatar() {
      try {
        const sel = doc.querySelector('#user_avatar_block .avatar-container.selected img');
        if (sel && sel.src) return sel.src;
        const ms = doc.querySelectorAll('#chat .mes[is_user="true"] .avatar img');
        if (ms.length && ms[ms.length - 1].src) return ms[ms.length - 1].src;
      } catch (e) { /* no picture: the initial is shown */ }
      return '';
    }
    const playerImg = () => (formStore && okUrl(formStore.img) ? formStore.img.trim() : personaAvatar());
    function portraitUrl(id) {
      const own = settings.img && settings.img[id];
      if (own) return own;
      const cu = customList.find((c) => c && c.id === id);
      if (cu && okUrl(cu.img)) return cu.img;
      if (PORTRAITS[id]) return PORTRAITS[id];
      if (settings.imgBase) return settings.imgBase.replace(/\/?$/, '/') + id + (settings.imgExt || '.png');
      return '';
    }

    function avatar(id, met) {
      const url = portraitUrl(id);
      const fallback = () => {
        const a = el('div', 'av', met ? LH.KO_NAME[id][0] : '?');
        a.style.background = COLORS[LH.NPCS.indexOf(id) % COLORS.length];
        return a;
      };
      if (!url || !met) return fallback(); // faces appear once the player has met them
      const img = el('img');
      img.style.background = COLORS[LH.NPCS.indexOf(id) % COLORS.length];
      img.alt = met ? LH.KO_NAME[id] : '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.addEventListener('error', () => { img.replaceWith(fallback()); });
      img.src = url;
      return img;
    }

    function personCard(s, id, at) {
      const met = !!(s.npc[id].met || s.affinity[id] > 0);
      const card = el('div', 'lh-pc');
      card.appendChild(avatar(id, met));
      const t = el('div', 't');
      const look = LH.looksToday(s, id);
      const sd = LH.NPC_DATA[id].side;
      t.appendChild(el('b', '', (met ? LH.KO_NAME[id] : `처음 보는 ${LH.ROLE[id][0]}`) + (met && sd ? (sd === 'store' ? ' 🏬' : ' 🎨') : '')));
      t.appendChild(el('div', '', `${ACT_NPC[`${id}/${at.spot}`] || ACT[at.spot] || at.spot} · ${KO.spot[at.spot] || at.spot}`));
      t.appendChild(el('div', '', `${look.emoji} ${look.ko}`));
      if (met) {
        const a = s.affinity[id];
        t.appendChild(el('div', '', `♥ ${a} ${KO.tier[LH.tierOf(a)]} · ${s.npc[id].giftedToday ? '🎁 오늘 선물함' : '🎁 아직 선물 안 함'}`));
      } else {
        t.appendChild(el('div', 'lh-muted', '아직 이름을 몰라요'));
      }
      card.appendChild(t);
      return card;
    }

    const MAP_POS = { meadow: [20, 22], hilltop: [80, 18], downtown: [38, 46], makers_row: [78, 58], harbor: [30, 86] };
    const MAP_ICON = { meadow: '🌾', hilltop: '🌻', downtown: '🏬', makers_row: '🎨', harbor: '⚓' };

    function renderTown(p, s) {
      const sel = pickedDistrict || s.place.district;
      const map = el('div', 'lh-map');
      map.appendChild(el('div', 'land'));
      for (const [l, t, w, h, bg] of [[3, 6, 32, 34, 'repeating-linear-gradient(90deg,#a3c46a 0 8px,#94b75c 8px 16px)'], [62, 3, 36, 34, '#7fa45d'],
        [22, 30, 32, 28, '#d9cba8'], [60, 44, 36, 24, '#d8c08e']]) {
        const z = el('div', 'z');
        z.style.cssText = `left:${l}%;top:${t}%;width:${w}%;height:${h}%;background:${bg}`;
        map.appendChild(z);
      }
      map.appendChild(el('div', 'pier'));
      const c = el('div', 'cannery', '🌬️');
      c.title = '언덕의 풍차';
      map.appendChild(c);
      for (const d of LH.DISTRICTS) {
        const count = LH.NPCS.filter((id) => { const w = LH.whereIs(s, id); return w && w.district === d; }).length;
        const label = `${d === s.place.district ? '📍' : MAP_ICON[d]} ${KO.district[d]}${count ? ` ${count}` : ''}`;
        const b = el('button', 'd' + (d === sel ? ' sel' : ''), label);
        b.style.left = `${MAP_POS[d][0]}%`;
        b.style.top = `${MAP_POS[d][1]}%`;
        b.title = `${KO.district[d]}: 지금 ${count}명`;
        b.addEventListener('click', (e) => { e.stopPropagation(); pickedDistrict = d; render(); });
        map.appendChild(b);
      }
      { // the player's own marker, with their photo if they set one
        const here = s.place.district;
        const me = el('div', 'me');
        const u = playerImg();
        const initial = (s.player.name || '나').trim()[0] || '나';
        if (u) {
          const im = el('img');
          im.referrerPolicy = 'no-referrer';
          im.alt = '';
          im.addEventListener('error', () => { im.remove(); me.textContent = initial; });
          im.src = u;
          me.appendChild(im);
        } else me.textContent = initial;
        const y = MAP_POS[here][1];
        me.style.left = `${MAP_POS[here][0]}%`;
        me.style.top = `${y < 30 ? y + 17 : y - 17}%`;
        me.title = '지금 내 위치';
        map.appendChild(me);
      }
      p.appendChild(map);

      const head = el('div', 'lh-row');
      head.appendChild(el('b', '', `${KO.district[sel]} · ${KO.slot[s.time.slot]}${sel === s.place.district ? ' (지금 여기)' : ''}`));
      if (sel !== s.place.district) {
        const mv = LH.buildActions(s).find((a) => a.key === `move_${sel}`);
        if (mv) {
          const b = el('button', '', '여기로 이동');
          b.addEventListener('click', (e) => { e.stopPropagation(); pickedDistrict = null; fire(mv); });
          head.appendChild(b);
        }
      }
      p.appendChild(head);

      const scn = (s.scene || []).filter((id) => LH.NPC_DATA[id]); // people walking with the player are wherever the player is
      const people = LH.NPCS.map((id) => ({ id, at: scn.includes(id) ? { district: s.place.district, spot: s.place.spot } : LH.whereIs(s, id) })).filter((x) => x.at && x.at.district === sel);
      if (!people.length) p.appendChild(el('div', 'lh-muted', '지금 이 구역에는 아무도 없어요.'));
      const grid = el('div', 'lh-pcs');
      for (const x of people) grid.appendChild(personCard(s, x.id, x.at));
      p.appendChild(grid);
      const home = LH.NPCS.filter((id) => (s.npc[id].met || s.affinity[id] > 0) && !LH.whereIs(s, id)).map((id) => LH.KO_NAME[id]);
      if (home.length) p.appendChild(el('div', 'lh-note', `🏠 집에 있거나 자리에 없음: ${home.join(', ')}`));
      p.appendChild(el('div', 'lh-note', '구역을 누르면 그곳에 누가 있는지 볼 수 있어요. 말을 걸지 말지는 직접 입력하세요.'));
    }

    // Home changes made in the panel need no AI reply: they are written as delta lines into the latest narrator
    // message and replayed like any other. A marker line (ui: <token>) lets the script put them back if that
    // reply is swiped or regenerated, so a purchase is never lost to a swipe.
    let homeBusy = false;
    const lastAi = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role !== 'user' && typeof msgs[i].message === 'string') return msgs[i]; return null; };
    function withLines(text, lines) {
      const mm = text.match(/<delta>([\s\S]*?)<\/delta>\s*$/);
      const body = mm ? text.slice(0, mm.index).replace(/\s+$/, '') : text.replace(/\s+$/, '');
      const keep = mm ? mm[1].split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
      return `${body}\n\n<delta>\n${[...keep, ...lines].join('\n')}\n</delta>`;
    }
    async function writeMessage(m, next) {
      if (typeof setChatMessages === 'function') await setChatMessages([{ message_id: m.message_id, message: next }], { refresh: 'affected' });
      else if (typeof setChatMessage === 'function') await setChatMessage({ message: next }, m.message_id, { refresh: 'display_and_render_current' });
      else throw new Error('no message api');
      m.message = next;
    }
    async function saveOps() { try { await updateVariablesWith((vars) => { vars.larkhaven_ops = opsStore; return vars; }, { type: 'chat' }); } catch (e) { /* retried with the next change */ } }
    // After a swipe or regenerate, the reply that carried the panel's lines has new text: write them back once it is complete.
    async function restoreOps(msgs) {
      if (!opsStore || isGen()) return;
      const m = lastAi(msgs);
      if (!m || m.message_id !== opsStore.id || m.message.includes(`ui: ${opsStore.tok}`)) return;
      if (m.message.trim().length < 2 || m.message.trim() === '...') return;
      try { await writeMessage(m, withLines(m.message, [`ui: ${opsStore.tok}`, ...opsStore.lines])); } catch (e) { console.warn('[Larkhaven] could not restore panel changes', e); }
    }
    async function instant(lines, okText) {
      if (homeBusy) return;
      if (isGen()) { setNotice('답변이 끝난 뒤에 눌러 주세요', 4000); return; }
      homeBusy = true;
      try {
        const msgs = await getChatMessages('0-{{lastMessageId}}');
        const m = lastAi(Array.isArray(msgs) ? msgs : []);
        if (!m) { setNotice('아직 이야기가 시작되지 않았어요', 4000); return; }
        if (opsStore && opsStore.id === m.message_id && m.message.includes(`ui: ${opsStore.tok}`)) {
          opsStore.lines.push(...lines);
          await writeMessage(m, withLines(m.message, lines));
        } else {
          opsStore = { id: m.message_id, tok: `h${Date.now().toString(36)}`, lines: lines.slice() };
          await writeMessage(m, withLines(m.message, [`ui: ${opsStore.tok}`, ...lines]));
        }
        await saveOps();
        await recompute();
        if (okText) setNotice(okText, 2500);
      } catch (e) {
        console.warn('[Larkhaven] instant home change failed', e);
        setNotice('적용하지 못했어요 — 다시 시도해 주세요', 5000);
      } finally { homeBusy = false; }
    }
    const THEME_KO = { modern: '🏬 모던 (백화점)', cottage: '🌾 코티지', harbor: '⚓ 항구', artisan: '🎨 공방', hill: '🌻 언덕' };
    const pretty = (id) => (KO.collect[id] || (KO.furn[id] || [])[1] || String(id).replace(/_/g, ' '));
    let shopTheme = 'all';
    let shopType = 'all';

    function renderHome(p, s) {
      const instBtn = (parent, label, lines, okText, enabled = true, title = '') => {
        const b = el('button', '', label);
        b.disabled = !enabled;
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); instant(lines, okText); });
        parent.appendChild(b);
        return b;
      };
      const h = s.home;
      const sc = LH.homeScore(s);
      const info = LH.HOUSE[h.level];
      p.appendChild(el('h4', '', '집'));
      const HK = ['', '기본', '확장', '가족용', '꿈의 집'];
      row(p, '집', `${LH.HOMES[LH.homeDistrict(s)].ko} · ${HK[h.level]} (Lv ${h.level}) · 자리 ${h.placed.length}/${info.slots}`);
      barRow(p, '🛋️ 편안함', `${sc.comfort}/100`, sc.comfort, 'low');
      barRow(p, '✨ 스타일', `${sc.style}/100`, sc.style, 'love');
      const fx = [];
      fx.push(sc.comfort >= 40 ? '✓ 낮잠 +45' : '낮잠 +45은 편안함 40↑');
      fx.push(sc.comfort >= 60 ? '✓ 집 휴식 +25' : '집 휴식 +25은 60↑');
      fx.push(sc.style >= 40 ? '✓ 방문객 호감도 +1' : '방문객 +1은 스타일 40↑');
      fx.push(sc.style >= 70 ? '✓ 집들이 사교 +50' : '집들이는 스타일 70↑');
      p.appendChild(el('div', 'lh-muted', fx.join(' · ')));
      if (h.pending) p.appendChild(el('div', 'lh-warn', `🔨 공사 중: Lv ${h.pending} — 내일 아침 완성`));

      // lay the placed pieces into their own slots, then the free slots
      const order = ['living', 'kitchen', 'bedroom', 'study', 'porch', 'decor'];
      const groups = {};
      for (const id of h.placed) (groups[LH.FURNITURE[id][0]] ||= []).push(id);
      const cells = [];
      const extra = [];
      for (const t of order) {
        const list = groups[t] || [];
        for (let i = 0; i < LH.BASE_SLOTS[t]; i++) cells.push({ t, id: list[i] || null });
        extra.push(...list.slice(LH.BASE_SLOTS[t]));
      }
      for (let i = 0; i < LH.anySlots(h.level); i++) cells.push({ t: 'any', id: extra[i] || null });
      p.appendChild(el('h4', '', '방'));
      const room = el('div', 'lh-room');
      for (const c of cells) {
        const cell = el('div', 'lh-cell' + (c.id ? '' : ' empty'));
        if (c.id) {
          const f = KO.furn[c.id] || ['📦', c.id];
          cell.title = `${f[1]}: 편안함 ${LH.FURNITURE[c.id][2]} / 스타일 ${LH.FURNITURE[c.id][3]}`;
          cell.appendChild(el('i', '', f[0]));
          cell.appendChild(el('span', '', f[1]));
          cell.style.cursor = 'pointer';
          cell.title += ' — 누르면 보관함으로';
          cell.addEventListener('click', (e) => { e.stopPropagation(); instant([`home.remove: ${c.id}`], '보관함으로 옮겼어요'); });
        } else {
          cell.appendChild(el('i', '', '＋'));
          cell.appendChild(el('span', '', KO.slotType[c.t]));
          cell.style.cursor = 'pointer';
          cell.title = '누르면 아래 상점이 이 자리에 맞는 가구만 보여 줘요';
          cell.addEventListener('click', (e) => { e.stopPropagation(); shopType = c.t === 'any' ? 'all' : c.t; render(); });
        }
        room.appendChild(cell);
      }
      p.appendChild(room);

      if (sc.sets.length) p.appendChild(el('div', 'lh-note', `🎀 세트 보너스: ${sc.sets.map((t) => THEME_KO[t]).join(', ')} (같은 테마 3개마다 편안함 +3, 스타일 +6)`));
      else p.appendChild(el('div', 'lh-note', '같은 테마 가구를 3개 놓으면 세트 보너스가 붙어요. 가구를 누르면 보관함으로, 빈 자리를 누르면 그 자리에 맞는 가구가 아래에 떠요.'));

      const placedCount = {};
      for (const id of h.placed) placedCount[id] = (placedCount[id] || 0) + 1;
      const free = (id) => LH.extrasNeeded([...h.placed, id]) <= LH.anySlots(h.level);

      // storage: owned but not placed
      const spare = Object.entries(s.inventory).filter(([id, q]) => LH.FURNITURE[id] && q > (placedCount[id] || 0));
      if (spare.length) {
        p.appendChild(el('h4', '', '보관함 (누르면 배치)'));
        const box = el('div', 'lh-acts');
        for (const [id, q] of spare) {
          const f = KO.furn[id] || ['📦', id];
          const n = q - (placedCount[id] || 0);
          instBtn(box, `${f[0]} ${f[1]}${n > 1 ? ` ×${n}` : ''}`, [`home.place: ${id}`], '배치했어요', free(id), free(id) ? '' : '맞는 빈 자리가 없어요');
        }
        p.appendChild(box);
      }

      // keepsakes on display
      const shown = h.shown || [];
      const cap = LH.SHOW_CAP[h.level];
      p.appendChild(el('h4', '', `진열장 · 추억의 물건 ${shown.length}/${cap}`));
      const shelf = el('div', 'lh-room');
      for (let i = 0; i < cap; i++) {
        const id = shown[i];
        const cell = el('div', 'lh-cell' + (id ? '' : ' empty'));
        cell.appendChild(el('i', '', id ? (KO.collect[id] ? '✨' : '🎁') : '＋'));
        cell.appendChild(el('span', '', id ? pretty(id) : '빈 칸'));
        if (id) { cell.style.cursor = 'pointer'; cell.title = '누르면 진열장에서 내려요'; cell.addEventListener('click', (e) => { e.stopPropagation(); instant([`home.unshow: ${id}`], '진열장에서 내렸어요'); }); }
        shelf.appendChild(cell);
      }
      p.appendChild(shelf);
      const keeps = [...Object.keys(s.inventory).filter((id) => !LH.FURNITURE[id]), ...s.collection].filter((id, i, arr) => arr.indexOf(id) === i && !shown.includes(id));
      if (keeps.length) {
        const box = el('div', 'lh-acts');
        for (const id of keeps) instBtn(box, `${KO.collect[id] ? '✨' : '🎁'} ${pretty(id)}`, [`home.show: ${id}`], '진열했어요', shown.length < cap, '진열장이 가득 찼어요');
        p.appendChild(box);
      }
      p.appendChild(el('div', 'lh-note', '이야기에서 받은 선물과 주운 물건, 수집품을 올려 둘 수 있어요. 하나마다 스타일 +2, 집에 온 손님이 알아보기도 해요.'));

      // shop
      const owned = Object.keys(LH.FURNITURE).filter((id) => (s.inventory[id] || 0) > 0).length;
      p.appendChild(el('h4', '', `가구 상점 · 도감 ${owned}/${Object.keys(LH.FURNITURE).length} · 소지금 $${s.money.toLocaleString('en-US')}`));
      const chipRow = (list, cur, set) => {
        const w = el('div', 'lh-acts');
        for (const [v, label] of list) {
          const b = el('button', cur === v ? 'on' : '', label);
          b.addEventListener('click', (e) => { e.stopPropagation(); set(v); render(); });
          w.appendChild(b);
        }
        p.appendChild(w);
      };
      chipRow([['all', '전체 테마'], ...LH.THEMES.map((t) => [t, THEME_KO[t]])], shopTheme, (v) => { shopTheme = v; });
      chipRow([['all', '전체 자리'], ...['living', 'kitchen', 'bedroom', 'study', 'porch', 'decor'].map((t) => [t, KO.slotType[t]])], shopType, (v) => { shopType = v; });
      const grid = el('div', 'lh-pcs');
      for (const [id, f] of Object.entries(LH.FURNITURE)) {
        if (!f[1]) continue; // starter pieces are not sold
        if (shopTheme !== 'all' && f[4] !== shopTheme) continue;
        if (shopType !== 'all' && f[0] !== shopType) continue;
        const k = KO.furn[id] || ['📦', id];
        const card = el('div', 'lh-pc');
        const av = el('div', 'av', k[0]);
        av.style.background = 'rgba(127,127,127,.22)';
        card.appendChild(av);
        const t = el('div', 't');
        t.appendChild(el('b', '', `${k[1]}${s.inventory[id] ? ` · 보유 ${s.inventory[id]}` : ''}`));
        t.appendChild(el('div', '', `${KO.slotType[f[0]]} · ${THEME_KO[f[4]] || ''}`));
        t.appendChild(el('div', '', `편안함 ${f[2]} · 스타일 ${f[3]}`));
        const can = s.money >= f[1];
        const lines = [`item.add: ${id}`, `money: -${f[1]}`];
        if (free(id)) lines.push(`home.place: ${id}`);
        const bw = el('div', 'lh-acts');
        instBtn(bw, `$${f[1]} 구매`, lines, free(id) ? '사서 바로 배치했어요' : '사서 보관함에 넣었어요', can, can ? '' : '돈이 부족해요');
        t.appendChild(bw);
        card.appendChild(t);
        grid.appendChild(card);
      }
      p.appendChild(grid);

      if (h.level < 4) {
        const nx = LH.HOUSE[h.level + 1];
        row(p, '다음 단계', `Lv ${h.level + 1} · 자리 ${nx.slots} · 진열장 ${LH.SHOW_CAP[h.level + 1]}칸 · $${nx.price.toLocaleString('en-US')}`);
        const bw = el('div', 'lh-btns');
        const can = !h.pending && s.money >= nx.price;
        instBtn(bw, `🔨 집 확장 주문 ($${nx.price.toLocaleString('en-US')})`, [`house.upgrade: ${h.level + 1}`, `money: -${nx.price}`], '주문했어요 — 내일 아침 완성', can, h.pending ? '이미 공사 중이에요' : '돈이 부족해요');
        p.appendChild(bw);
      } else {
        p.appendChild(el('div', 'lh-muted', '최고 단계의 집이에요.'));
      }
      p.appendChild(el('div', 'lh-note', '이 탭의 구매와 배치는 AI 답변 없이 바로 적용돼요.'));
    }

    function renderAchievements(p, s) {
      p.appendChild(el('h4', '', `📦 수집 ${s.collection.length}/${Object.values(LH.COLLECT).reduce((a, b) => a + b.length, 0)}`));
      for (const d of LH.DISTRICTS) {
        const ids = LH.COLLECT[d];
        const got = ids.filter((id) => s.collection.includes(id));
        const r = el('div', 'lh-row');
        r.appendChild(el('span', got.length === ids.length ? 'lh-ok' : '', `${KO.collectSet[d]} ${got.length}/${ids.length}`));
        r.appendChild(el('span', 'lh-muted', s.today.collected.includes(d) ? '오늘 찾음 ✓' : '오늘 아직'));
        p.appendChild(r);
        if (got.length) p.appendChild(el('div', 'lh-note', got.map((id) => KO.collect[id] || id).join(' · ')));
      }
      p.appendChild(el('div', 'lh-muted', '구역마다 하루에 하나만 찾을 수 있어요. 👆 행동 → 🔎 주변 둘러보기'));
      const total = LH.ACHV.reduce((a, b) => a + b.reward, 0);
      const got = LH.ACHV.filter((a) => s.achievements.includes(a.id));
      p.appendChild(el('h4', '', `업적 ${got.length}/${LH.ACHV.length} · 받은 보상 $${got.reduce((a, b) => a + b.reward, 0)} / $${total}`));
      for (const a of LH.ACHV) {
        const done = s.achievements.includes(a.id);
        const k = KO.achv[a.id] || [a.id, ''];
        const r = el('div', 'lh-row');
        const left = el('span', done ? 'lh-ok' : '', `${done ? '✓' : '🔒'} ${k[0]}`);
        const right = el('span', 'lh-muted', `${k[1]} · $${a.reward}${a.type === 'N' ? ' ✎' : ''}`);
        r.appendChild(left);
        r.appendChild(right);
        p.appendChild(r);
      }
      p.appendChild(el('div', 'lh-muted', '✎ 표시는 이야기에서 장면이 일어나야 달성돼요. 나머지는 자동으로 달성돼요.'));
    }

    /* ---------- character manager: add townspeople, or add notes to the original ones ---------- */
    const DSPOT = {
      downtown: ['town_square', 'ashcroft_store', 'nocturne_bar', 'clinic', 'construction_site'],
      makers_row: ['old_mill_market', 'street_stage', 'flower_shop', 'finch_teahouse', 'sakaki_pottery'],
      meadow: ['orchard', 'pond', 'fairground', 'mercer_farm', 'hale_farm'],
      harbor: ['pier', 'salty_whisker', 'fish_market', 'food_stalls', 'beach', 'lighthouse'],
      hilltop: ['sunflower_field', 'windmill', 'glass_greenhouse', 'stargazing_rock'],
    };
    const LIB_KEY = 'larkhaven_custom_lib_v1';
    let ned = null; // null (closed) | { view: 'list' } | { view: 'edit', rec, isNew, base }
    const isBase = (id) => LH.BASE_NPCS.includes(id);
    const libLoad = () => { try { const a = JSON.parse(window.localStorage.getItem(LIB_KEY) || '[]'); return Array.isArray(a) ? a.filter((c) => c && typeof c.id === 'string' && !isBase(c.id)) : []; } catch (e) { return []; } };
    function nedClose() { ned = null; const o = doc.getElementById(CAS_ID); if (o) o.remove(); render(); }
    function nedOpen() { casStyle(); cas = null; ned = { view: 'list' }; nedDraw(); }
    async function nedPersist() {
      const list = customList.slice();
      try { await updateVariablesWith((vars) => { vars.larkhaven_custom = list; return vars; }, { type: 'chat' }); } catch (e) { console.warn('[Larkhaven] could not save custom townspeople', e); setNotice('저장에 실패했어요', 5000); }
      try { window.localStorage.setItem(LIB_KEY, JSON.stringify(list.filter((c) => !isBase(c.id)))); } catch (e) { /* the library is optional */ }
      LH.setCustom(customList);
      savedJson = ''; lastJson = '';
      await recompute();
    }
    function nedNewId(name) {
      const taken = new Set([...LH.NPCS, ...customList.map((c) => c.id)]);
      const slug = String(name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 14);
      if (slug.length >= 2 && !taken.has(slug)) return slug;
      for (const ch of 'abcdefghijklmnopqrstuvwxyz') if (!taken.has(`extra${ch}`)) return `extra${ch}`;
      return '';
    }
    function nedDraw() {
      if (!ned) return;
      let o = doc.getElementById(CAS_ID);
      if (!o) {
        o = el('div', '');
        o.id = CAS_ID;
        o.addEventListener('click', (e) => { if (e.target === o) nedClose(); });
        doc.body.appendChild(o);
      }
      o.replaceChildren();
      const box = el('div', 'c-box');
      const head = el('div', 'c-head');
      head.appendChild(el('div', 'c-gem'));
      const tt = el('div', '');
      tt.appendChild(el('div', 'c-title', '캐릭터 추가 · 수정'));
      tt.appendChild(el('div', 'c-sub', 'LARKHAVEN · 이 채팅에만 적용돼요'));
      head.appendChild(tt);
      const x = el('button', 'c-x', '✕');
      x.addEventListener('click', () => nedClose());
      head.appendChild(x);
      box.appendChild(head);
      const pane = el('div', 'c-scroll');
      pane.style.cssText = 'padding:8px 14px 10px';
      const sec = (title) => { const s2 = el('div', 'c-sec'); s2.appendChild(el('h5', '', title)); pane.appendChild(s2); return s2; };
      const input = (parent, rec, key, ph, rows) => {
        const i = el(rows ? 'textarea' : 'input', 'c-in');
        i.placeholder = ph;
        i.value = rec[key] || '';
        if (rows) i.rows = rows;
        i.addEventListener('input', () => { rec[key] = i.value; });
        parent.appendChild(i);
        return i;
      };
      const chips = (parent, rec, key, list) => {
        const w = el('div', 'c-opts');
        for (const [v, label] of list) {
          const b = el('button', 'c-opt' + (rec[key] === v ? ' on' : ''), label);
          b.addEventListener('click', () => { rec[key] = v; nedDraw(); });
          w.appendChild(b);
        }
        parent.appendChild(w);
      };
      const foot = el('div', 'c-foot');
      if (ned.view === 'list') {
        const mine = customList.filter((c) => !isBase(c.id));
        const s1 = sec(`내가 추가한 캐릭터 (${mine.length}/12)`);
        if (!mine.length) s1.appendChild(el('div', 'c-note', '아직 없어요. 친구, 라이벌, 가족, 새 공략 대상까지 누구든 추가할 수 있어요.'));
        for (const c of mine) {
          const r = el('div', '');
          r.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0';
          const nm = el('span', '', `${c.name} (${c.id}) · ${c.romance ? '💗 공략 가능' : '우정만'} · ${KO.district[c.district] || ''}`);
          nm.style.flex = '1';
          r.appendChild(nm);
          const eb = el('button', 'c-opt', '수정');
          eb.addEventListener('click', () => { ned = { view: 'edit', rec: { ...c }, isNew: false, base: false }; nedDraw(); });
          const db = el('button', 'c-opt', '삭제');
          db.title = '한 번 더 누르면 삭제돼요. 이 캐릭터와 쌓은 호감도도 사라져요.';
          db.addEventListener('click', async () => {
            if (ned.confirm !== c.id) { ned.confirm = c.id; db.textContent = '정말 삭제?'; return; }
            customList = customList.filter((z) => z.id !== c.id);
            ned = { view: 'list' };
            await nedPersist();
            nedDraw();
          });
          r.appendChild(eb); r.appendChild(db);
          s1.appendChild(r);
        }
        const add = el('button', 'c-btn go', '＋ 새 캐릭터 추가');
        add.disabled = mine.length >= 12;
        add.addEventListener('click', () => { ned = { view: 'edit', isNew: true, base: false, rec: { id: '', name: '', role: '', romance: false, diff: 1.0, side: '', district: 'downtown', spot: 'town_square', slots: 'MAE', profile: '', img: '' } }; nedDraw(); });
        s1.appendChild(add);
        const lib = libLoad().filter((c) => !customList.some((z) => z.id === c.id) && !LH.NPC_DATA[c.id]);
        if (lib.length) {
          const lb = el('button', 'c-btn', `📦 다른 채팅에서 만든 캐릭터 불러오기 (${lib.length}명)`);
          lb.style.marginLeft = '6px';
          lb.addEventListener('click', async () => { customList = [...customList, ...lib].slice(0, 12 + LH.BASE_NPCS.length); await nedPersist(); nedDraw(); });
          s1.appendChild(lb);
        }
        const s2 = sec('원래 주민에게 설정 덧붙이기');
        s2.appendChild(el('div', 'c-note', '성격을 바꾸거나 나와의 과거를 더하는 등, 여기에 적은 내용은 그 사람의 기본 설정보다 우선해요. ✎ 는 이미 적어 둔 사람이에요.'));
        const w = el('div', 'c-opts');
        for (const id of LH.BASE_NPCS) {
          const has = customList.find((c) => c.id === id && c.profile);
          const b = el('button', 'c-opt' + (has ? ' on' : ''), `${has ? '✎ ' : ''}${LH.KO_NAME[id]}`);
          b.addEventListener('click', () => { ned = { view: 'edit', isNew: !has, base: true, rec: has ? { ...has } : { id, profile: '' } }; nedDraw(); });
          w.appendChild(b);
        }
        s2.appendChild(w);
        const cl = el('button', 'c-btn', '닫기');
        cl.addEventListener('click', () => nedClose());
        foot.appendChild(cl);
      } else {
        const rec = ned.rec;
        if (ned.base) {
          const s1 = sec(`${LH.KO_NAME[rec.id]} · 덧붙일 설정`);
          input(s1, rec, 'profile', '예: 어릴 적 나와 같은 동네에 살았던 소꿉친구. 나에게만 반말을 쓴다. (최대 1200자)', 7);
          s1.appendChild(el('div', 'c-note', '이 사람이 장면에 있을 때만 AI에게 전달돼요. 비우고 저장하면 원래대로 돌아가요. 사진은 ⚙️ 설정 탭에서 바꿀 수 있어요.'));
        } else {
          const s1 = sec('이름');
          input(s1, rec, 'name', '예: 미나, Theo');
          const s2 = sec('한 줄 소개');
          input(s2, rec, 'role', '예: 서점 주인 / the bookshop owner (처음 만나기 전에 이렇게 불려요)');
          chips(sec('관계'), rec, 'romance', [[false, '우정만'], [true, '💗 공략 가능']]);
          chips(sec('친해지는 속도'), rec, 'diff', [[1.25, '쉬움'], [1.0, '보통'], [0.7, '어려움']]);
          chips(sec('진영'), rec, 'side', [['', '중립'], ['store', '🏬 백화점 쪽'], ['market', '🎨 시장 쪽']]);
          const s3 = sec('주로 있는 곳');
          const dw = el('div', 'c-opts');
          for (const d of LH.DISTRICTS) {
            const b = el('button', 'c-opt' + (rec.district === d ? ' on' : ''), KO.district[d]);
            b.addEventListener('click', () => { rec.district = d; rec.spot = DSPOT[d][0]; nedDraw(); });
            dw.appendChild(b);
          }
          s3.appendChild(dw);
          chips(s3, rec, 'spot', DSPOT[rec.district].map((sp) => [sp, KO.spot[sp] || sp]));
          const s4 = sec('나타나는 시간대');
          const tw = el('div', 'c-opts');
          'MAEN'.split('').forEach((ch, i) => {
            const on = String(rec.slots || '').includes(ch);
            const b = el('button', 'c-opt' + (on ? ' on' : ''), KO.slot[i]);
            b.addEventListener('click', () => { rec.slots = on ? String(rec.slots).replace(ch, '') : `${rec.slots || ''}${ch}`; nedDraw(); });
            tw.appendChild(b);
          });
          s4.appendChild(tw);
          const s5 = sec('프로필 (외모 · 성격 · 말투 · 사연)');
          input(s5, rec, 'profile', '자유롭게 적어 주세요. 이 사람이 장면에 있을 때 AI가 이 내용대로 연기해요. (최대 1200자)', 7);
          const s6 = sec('사진 주소 (선택)');
          input(s6, rec, 'img', 'https://… 로 시작하는 이미지 주소');
          if (!ned.isNew) pane.appendChild(el('div', 'c-note', `AI가 쓰는 ID: ${rec.id} (바꿀 수 없어요)`));
        }
        const cancel = el('button', 'c-btn', '◀ 목록으로');
        cancel.addEventListener('click', () => { ned = { view: 'list' }; nedDraw(); });
        foot.appendChild(cancel);
        const save = el('button', 'c-btn go', '💾 저장');
        save.addEventListener('click', async () => {
          if (ned.base) {
            const text = clean(rec.profile, 1200);
            customList = customList.filter((c) => c.id !== rec.id);
            if (text) customList.push({ id: rec.id, profile: text });
          } else {
            const name = clean(rec.name, 40);
            if (!name) { setNotice('이름을 적어 주세요', 4000); return; }
            const id = ned.isNew ? nedNewId(name) : rec.id;
            if (!id) { setNotice('더 추가할 수 없어요', 4000); return; }
            const out = { id, name, role: clean(rec.role, 60), romance: !!rec.romance, diff: rec.diff, side: rec.side || '', district: rec.district, spot: rec.spot,
              slots: String(rec.slots || '').replace(/[^MAEN]/g, '') || 'MAE', profile: clean(rec.profile, 1200), img: okUrl(rec.img) ? rec.img.trim() : '' };
            customList = customList.filter((c) => c.id !== id);
            customList.push(out);
          }
          ned = { view: 'list' };
          await nedPersist();
          nedDraw();
          setNotice('저장했어요', 3000);
        });
        foot.appendChild(save);
      }
      box.appendChild(pane);
      box.appendChild(foot);
      o.appendChild(box);
    }

    function renderRelations(p, s) {
      { const mb = el('div', 'lh-btns'); const b = el('button', '', '🧑‍🤝‍🧑 캐릭터 추가 · 수정'); b.title = '새 주민을 추가하거나, 원래 주민에게 내 설정을 덧붙여요'; b.addEventListener('click', (e) => { e.stopPropagation(); nedOpen(); }); mb.appendChild(b); p.appendChild(mb); }
      const known = LH.NPCS.filter((id) => s.npc[id].met || s.affinity[id] > 0).sort((a, b) => s.affinity[b] - s.affinity[a]);
      if (!known.length) p.appendChild(el('div', 'lh-muted', '아직 만난 주민이 없어요.'));
      if (s.memos && s.memos.length) {
        p.appendChild(el('h4', '', '📖 이야기 메모'));
        const nowI = LH.dayIndex(s.time);
        const mm = el('div', 'lh-memos');
        for (const m of s.memos.slice().reverse()) mm.appendChild(el('div', '', `${nowI - m.d <= 0 ? '오늘' : `${nowI - m.d}일 전`} · ${m.t}`));
        p.appendChild(mm);
        p.appendChild(el('h4', '', '주민'));
      }
      for (const id of known) {
        const d = LH.NPC_DATA[id];
        const n = s.npc[id];
        const a = s.affinity[id];
        const box = el('div', 'lh-npc');
        const head = el('div', 'lh-row');
        head.appendChild(el('span', '', LH.KO_NAME[id] + (d.side ? (d.side === 'store' ? ' 🏬' : ' 🎨') : '') + (LH.isBirthday(s.time, id) ? ' 🎂' : '')));
        head.appendChild(el('span', 'lh-muted', `${KO.tier[LH.tierOf(a)]} · ${a}`));
        box.appendChild(head);
        const track = el('div', 'lh-track');
        const fill = el('div', 'lh-fill love');
        fill.style.width = `${a}%`;
        track.appendChild(fill);
        box.appendChild(track);
        const info = el('div', 'lh-row lh-muted');
        info.appendChild(el('span', 'lh-hearts', '♥'.repeat(n.events.length) + '♡'.repeat(4 - n.events.length)));
        if (n.events.length < 4 && a >= LH.EVENT_AT[n.events.length]) info.appendChild(el('span', '', ' ✨ 하트 이벤트 가능'));
        const bits = [];
        if (n.romance !== 'none') bits.push(KO.romance[n.romance]);
        else if (!d.romance) bits.push('우정만');
        if (n.giftedToday) bits.push('🎁 오늘 선물함');
        if (n.todayGain >= LH.RULES.dailyAffinityCap) bits.push('오늘 대화 한도');
        info.appendChild(el('span', '', bits.join(' · ')));
        box.appendChild(info);
        const withMe = (s.scene || []).includes(id);
        const at = withMe ? { district: s.place.district, spot: s.place.spot } : LH.whereIs(s, id);
        box.appendChild(el('div', 'lh-note', withMe ? '📍 지금 함께 있어요' : at ? `📍 지금 ${KO.district[at.district] || at.district} · ${KO.spot[at.spot] || at.spot}` : '🏠 지금은 집에 있거나 자리에 없어요'));
        const nowIdx = LH.dayIndex(s.time);
        const days = [];
        if (n.metDay !== null && n.metDay !== undefined) days.push(`📅 만난 지 ${nowIdx - n.metDay + 1}일째`);
        if (n.romance !== 'none' && n.romanceSince !== null) days.push(`${KO.romance[n.romance]} ${nowIdx - n.romanceSince + 1}일째`);
        if (days.length) box.appendChild(el('div', 'lh-note', days.join(' · ')));
        if (d.romance) {
          const isFocus = LH.focusOf(s) === id;
          const fb = el('button', isFocus ? 'on' : '', isFocus ? '💘 이 사람 루트 집중 중 (누르면 해제)' : '💘 이 사람 루트에 집중');
          fb.title = '한 사람에게 집중하면 다른 공략 대상은 친구로만 남고, 하트 이벤트·찾아오기 알림도 이 사람 것만 떠요.';
          fb.addEventListener('click', (e) => {
            e.stopPropagation();
            const ok = setInput(isFocus
              ? '(OOC: 루트 고정을 풀게. 이번 답변 <delta>에 "flag: route=open" 을 적어 줘. 이야기는 그대로 이어서.)'
              : `(OOC: 이제 ${LH.KO_NAME[id]} 루트에 집중할게. 이번 답변 <delta>에 "flag: route=${id}" 를 적어 줘. 이야기는 그대로 이어서.)`, false);
            if (ok) setNotice('입력창에 넣었어요 — 하고 싶은 행동을 덧붙여 보내세요', 4000);
          });
          box.appendChild(fb);
        }
        if (n.thought) box.appendChild(el('div', 'lh-thought', `💭 ${n.thought}`));
        if (n.memos && n.memos.length) {
          const mm = el('div', 'lh-memos');
          for (const m of n.memos.slice().reverse()) mm.appendChild(el('div', '', `📝 ${nowIdx - m.d <= 0 ? '오늘' : `${nowIdx - m.d}일 전`} · ${m.t}`));
          box.appendChild(mm);
        }
        p.appendChild(box);
      }
      const unmet = LH.NPCS.length - known.length;
      if (unmet > 0) p.appendChild(el('div', 'lh-muted', `아직 만나지 못한 주민 ${unmet}명`));
      if (s.flags.includes('double_dating')) p.appendChild(el('div', 'lh-warn', '⚠ 두 사람과 동시에 만나는 중이에요. 들키면 둘 다 호감도 -15.'));
      const riv = LH.rivalRomances(s);
      if (riv.length) p.appendChild(el('div', 'lh-note', `🤫 적진 로맨스: ${riv.map((id) => LH.KO_NAME[id]).join(', ')} (몰래 만나는 중)`));
      p.appendChild(el('div', 'lh-muted', '🏬 백화점 쪽 · 🎨 시장 쪽 · 표시 없음은 중립'));
      p.appendChild(el('div', 'lh-note', '💭 속마음과 📝 추억은 이야기 속에서 AI가 남겨요. 추억은 주민마다 최근 6개까지 기억돼요.'));
    }

    /* ---------- create-a-resident (character creation, v2.4) ---------- */
    const CAS = {
      pron: [['she/her', '그녀 (she/her)'], ['he/him', '그 (he/him)']],
      age: [['early 20s', '20대 초반'], ['mid 20s', '20대 중반'], ['late 20s', '20대 후반'], ['30s', '30대']],
      hair: [['black', '#1b1b1f', '흑발'], ['dark brown', '#4a2f22', '짙은 갈색'], ['chestnut', '#8a5634', '밤색'], ['honey blonde', '#d9b26a', '금발'],
        ['platinum blonde', '#ebe4cf', '백금발'], ['silver', '#b8bcc6', '은발'], ['red', '#a8322d', '적발'], ['pink', '#e8a0b8', '분홍'],
        ['lavender', '#b9a3d8', '라벤더'], ['blue-black', '#1f2a44', '청흑발']],
      hairStyle: [['short', '숏컷'], ['bob', '단발'], ['long straight', '긴 생머리'], ['long wavy', '긴 웨이브'], ['curly', '곱슬'], ['ponytail', '포니테일'], ['braided', '땋은 머리']],
      eyes: [['dark brown', '#3b2418', '흑갈색'], ['hazel', '#8e6b3a', '헤이즐'], ['amber', '#c98a2b', '호박색'], ['green', '#4f8a5b', '초록'],
        ['blue', '#4a7fc1', '파랑'], ['grey', '#8d96a0', '회색'], ['violet', '#8a6bbf', '보라'], ['red', '#b0383c', '붉은색']],
      height: [['petite', '작은 편'], ['average height', '보통'], ['tall', '큰 편']],
      vibe: [['innocent', '청순'], ['chic', '시크'], ['lovely', '사랑스러움'], ['cat-like', '고양이상'], ['puppy-like', '강아지상'], ['elegant', '우아함'], ['sleepy', '나른함'], ['bold', '당당함']],
      style: [['casual', '캐주얼'], ['feminine', '페미닌'], ['street', '스트릿'], ['classic', '클래식'], ['vintage', '빈티지'], ['sporty', '스포티'], ['gothic', '고딕']],
      traits: [['green_thumb', '🌱', '초록 손', '원예 경험치 +20%'], ['anglers_luck', '🎣', '낚시 운', '낚시 경험치 +20%'], ['foodie', '🍳', '미식가', '요리 경험치 +20%, 집밥 +10'],
        ['handy', '🔨', '손재주', '공예 경험치 +20%'], ['charmer', '💬', '매력꾼', '첫 만남 호감도 +2'], ['creative_soul', '🎨', '창작혼', '예술 경험치 +20%'],
        ['homebody', '🏠', '집순이', '사교 감소 절반'], ['night_owl', '🦉', '올빼미', '저녁·밤 경험치 +10%']],
      why: [['Burned out and quit a city job', '번아웃으로 퇴사'], ['Left after a breakup', '이별'], ['Inherited the cottage lease from a grandmother', '할머니가 남긴 집'],
        ['Wanted a fresh start', '그냥 새 출발'], ['Is running from something', '무언가로부터 도망'], ['Came because of a letter from someone in town', '마을에서 온 편지 한 통']],
      lean: [['', '아직 몰라요'], ["Ashcroft's (store side)", '🏬 백화점'], ['The Salty Whisker cafe', '☕ 카페'], ['farm work', '🌾 농장'],
        ['the harbor', '⚓ 항구'], ['the Old Mill workshops (market side)', '🎨 공방'], ['freelance', '🧰 프리랜서']],
      home: [['meadow', '🌾', '렌 코티지', '들판', '햇살 드는 농가 오두막. 옆집은 가레트와 로언, 버터가 놀러 와요. 조용하고 느긋해요.'],
        ['downtown', '🏬', '글라스하우스 로프트', '중심가 · 백화점 쪽', '백화점 맞은편 부티크 위층. 밤엔 네온, 창 너머로 데이먼의 사무실이 보여요.'],
        ['makers_row', '🎨', '방앗간 다락방', '공방 거리 · 시장 쪽', '꽃집 위 경사 지붕 다락방. 아래층엔 Bea, 새벽엔 망치 소리, 문 앞이 파비안의 무대예요.'],
        ['harbor', '⚓', '갈매기 집', '항구', '그물 가게 위 2층. 사샤의 카페가 두 집 건너, 계단엔 늘 고양이가 있어요.'],
        ['hilltop', '🌻', '윈드로 코티지', '랜턴 언덕', '풍차 아래 돌집. 이웃은 넬과 베스퍼, 문 앞엔 흰 토끼가 와요.']],
      first: [['Go home and unpack', '🏡 집에 가서 짐 풀기'], ['Walk around the neighborhood', '🚶 동네 한 바퀴'],
        ['Find somewhere to eat breakfast', '☕ 아침 먹을 곳 찾기'], ['Explore another district', '🗺️ 다른 구역 구경']],
      steps: ['기본', '외모', '성격', '사연', '집', '첫날'],
    };
    const CAS_ID = 'larkhaven-cas';
    let cas = null;            // form being edited
    let casDismissed = false;  // closed by the player for this chat
    let msgCount = 0;          // messages in the chat at the last recompute

    function casDefault() {
      const s = latest && latest.state;
      const p = s ? s.player : {};
      let persona = '';
      try { const c = stContext(); if (c && typeof c.name1 === 'string') persona = c.name1.trim().slice(0, 40); } catch (e) { /* no persona */ }
      if (formStore) { // reopen with what the player chose last time, not the defaults
        const f = { ...formStore };
        delete f.aiBusy; delete f.aiOpen;
        return { whyMemo: '', memo: '', firstMemo: '', first: CAS.first[0][0], traits: [], ...f, step: 0, name: p.name || f.name || persona, home: (p && p.home) || f.home || 'meadow', edit: !!(p && p.name), aiPersona: true, aiKeep: true };
      }
      return { aiPersona: true, aiKeep: true, step: 0, name: p.name || persona, pron: 'she/her', age: 'mid 20s', hair: 'black', hairStyle: 'long straight', eyes: 'dark brown',
        height: 'average height', vibe: 'lovely', style: 'casual', memo: '', traits: p.traits ? p.traits.slice(0, 2) : [], why: 'Wanted a fresh start',
        whyMemo: '', lean: '', home: (p && p.home) || 'meadow', first: CAS.first[0][0], firstMemo: '', edit: !!(p && p.name) };
    }
    const ko = (list, v) => { const f = list.find((x) => x[0] === v); return f ? f[f.length - 1] : v; };
    const pickR = (list) => list[Math.floor(Math.random() * list.length)][0];
    // every chip group also has a free-text box (key + 'X'); when filled it replaces the chip
    const CAS_X = ['pron', 'age', 'hair', 'hairStyle', 'eyes', 'height', 'vibe', 'style', 'why', 'lean'];
    const cx = (k) => String((cas && cas[`${k}X`]) || '').replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, k === 'why' ? 200 : 80);
    const cv = (k) => cx(k) || cas[k];
    const kv = (list, k) => cx(k) || ko(list, cas[k]);

    function casRandom() {
      const keep = cas.name;
      for (const k of CAS_X) cas[`${k}X`] = '';
      Object.assign(cas, { pron: cas.pron, age: pickR(CAS.age), hair: pickR(CAS.hair), hairStyle: pickR(CAS.hairStyle), eyes: pickR(CAS.eyes),
        height: pickR(CAS.height), vibe: pickR(CAS.vibe), style: pickR(CAS.style), why: pickR(CAS.why), lean: pickR(CAS.lean), home: pickR(CAS.home), first: pickR(CAS.first) });
      const t = CAS.traits.map((x) => x[0]).sort(() => Math.random() - 0.5);
      cas.traits = t.slice(0, 2);
      cas.name = keep || ['Robin', 'Mira', 'Nova', 'Hazel', 'Iris', 'June', 'Wren', 'Elle'][Math.floor(Math.random() * 8)];
    }

    const clean = (v, n) => String(v || '').replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
    function casLook() {
      if (['age', 'height', 'hair', 'hairStyle', 'eyes', 'vibe', 'style'].some((k) => cx(k))) {
        const hair = cx('hair') ? cx('hair') + (cx('hairStyle') ? `, ${cx('hairStyle')}` : '') : `${cas.hair}, ${cv('hairStyle')}`;
        return clean(`age: ${cv('age')}; height: ${cv('height')}; hair: ${hair}; eyes: ${cv('eyes')}; impression: ${cv('vibe')}; style: ${cv('style')}${cas.memo ? `; ${cas.memo}` : ''}`, 320);
      }
      return clean(`${cas.age}, ${cas.height}, ${cas.hair} ${cas.hairStyle} hair, ${cas.eyes} eyes, a ${cas.vibe} face, ${cas.style} style${cas.memo ? `; ${cas.memo}` : ''}`, 320);
    }
    function casBackstory() {
      return clean(`${cv('why')}${cas.whyMemo ? ` (${cas.whyMemo})` : ''}${cv('lean') ? `; leaning toward work at ${cv('lean')}` : ''}`, 320);
    }

    function casStyle() {
      if (doc.getElementById(CAS_ID + '-st')) return;
      const st = doc.createElement('style');
      st.id = CAS_ID + '-st';
      st.textContent = `
#${CAS_ID}{position:fixed;left:0;top:0;right:0;bottom:0;height:100vh;height:100dvh;box-sizing:border-box;z-index:4000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);
  backdrop-filter:blur(3px);font-size:13px;line-height:1.4;color:var(--SmartThemeBodyColor,#ddd);font-family:inherit;padding:10px}
#${CAS_ID} *{box-sizing:border-box}
#${CAS_ID} .c-box{width:min(880px,100%);max-height:min(100%,760px);display:flex;flex-direction:column;overflow:hidden;border-radius:16px;
  background:var(--SmartThemeBlurTintColor,rgba(22,24,28,.97));border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));box-shadow:0 10px 40px rgba(0,0,0,.45)}
#${CAS_ID} .c-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(127,127,127,.25)}
#${CAS_ID} .c-gem{width:16px;height:22px;background:linear-gradient(160deg,#9dffb0,#2fb35a 60%,#147a37);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);
  filter:drop-shadow(0 0 6px rgba(80,220,120,.6));animation:cgem 2.4s ease-in-out infinite}
@keyframes cgem{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
#${CAS_ID} .c-title{font-weight:700;font-size:15px;letter-spacing:.5px}
#${CAS_ID} .c-sub{opacity:.65;font-size:12px}
#${CAS_ID} .c-x{margin-left:auto;cursor:pointer;opacity:.7;font-size:18px;background:none;border:0;color:inherit}
#${CAS_ID} .c-steps{display:flex;gap:4px;padding:8px 16px;flex-wrap:wrap}
#${CAS_ID} .c-steps button{flex:1;min-width:58px;padding:6px 4px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;font-size:12px}
#${CAS_ID} .c-steps button.on{background:#2fb35a;border-color:#2fb35a;color:#fff;font-weight:700}
#${CAS_ID} .c-steps button.done{border-color:#2fb35a}
#${CAS_ID} .c-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
#${CAS_ID} .c-head,#${CAS_ID} .c-steps,#${CAS_ID} .c-foot{flex:0 0 auto}
#${CAS_ID} .c-main{display:grid;grid-template-columns:250px minmax(0,1fr);gap:14px;padding:6px 16px 12px}
@media (max-width:640px){#${CAS_ID}{padding:6px;align-items:flex-start}#${CAS_ID} .c-head{padding:8px 12px}#${CAS_ID} .c-steps{flex-wrap:nowrap;overflow-x:auto;padding:6px 10px;scrollbar-width:none}#${CAS_ID} .c-steps button{flex:0 0 auto;min-width:0;padding:6px 10px}#${CAS_ID} .c-foot{padding:8px 10px}#${CAS_ID} .c-btn{padding:8px 10px;font-size:13px}#${CAS_ID} input.c-in,#${CAS_ID} textarea.c-in{font-size:16px}#${CAS_ID} .c-trait{grid-template-columns:1fr 1fr}#${CAS_ID} .c-main{grid-template-columns:minmax(0,1fr);padding:6px 10px 10px}#${CAS_ID} .c-card{position:static!important;padding:10px}#${CAS_ID} .c-ava{width:62px;height:62px;margin:6px auto 2px}#${CAS_ID} .c-ava i{bottom:16px;width:9px;height:9px}#${CAS_ID} .c-ava i.l{left:17px}#${CAS_ID} .c-ava i.r{right:17px}#${CAS_ID} .c-lines{font-size:11px;gap:2px;margin-top:6px}}
#${CAS_ID} .c-card{position:sticky;top:0;align-self:start;border-radius:14px;padding:14px;text-align:center;
  background:linear-gradient(170deg,rgba(47,179,90,.18),rgba(127,127,127,.06));border:1px solid rgba(47,179,90,.45)}
#${CAS_ID} .c-tag{font-size:10px;letter-spacing:3px;opacity:.7}
#${CAS_ID} .c-ava{width:96px;height:96px;margin:10px auto 6px;border-radius:50%;position:relative;border:3px solid rgba(255,255,255,.75);box-shadow:0 3px 10px rgba(0,0,0,.3)}
#${CAS_ID} .c-ava i{position:absolute;bottom:26px;width:12px;height:12px;border-radius:50%;border:2px solid #fff}
#${CAS_ID} .c-ava i.l{left:28px}#${CAS_ID} .c-ava i.r{right:28px}
#${CAS_ID} .c-name{font-size:18px;font-weight:700;margin-top:4px;word-break:break-all}
#${CAS_ID} .c-pron{opacity:.65;font-size:12px}
#${CAS_ID} .c-lines{text-align:left;font-size:12px;margin-top:10px;display:flex;flex-direction:column;gap:5px}
#${CAS_ID} .c-badge{display:inline-block;margin:2px 3px 0 0;padding:1px 8px;border-radius:999px;background:rgba(47,179,90,.25);font-size:11.5px}
#${CAS_ID} .c-sec{margin-bottom:12px}
#${CAS_ID} .c-sec h5{margin:0 0 6px;font-size:12px;opacity:.75;font-weight:600}
#${CAS_ID} .c-opts{display:flex;flex-wrap:wrap;gap:6px}
#${CAS_ID} .c-opt{padding:6px 11px;border-radius:999px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;font-size:12.5px}
#${CAS_ID} .c-opt.on{background:rgba(47,179,90,.28);border-color:#2fb35a;font-weight:600}
#${CAS_ID} .c-sw{width:30px;height:30px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.25);padding:0}
#${CAS_ID} .c-sw.on{outline:3px solid #2fb35a;outline-offset:2px}
#${CAS_ID} .c-trait{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#${CAS_ID} .c-tr{padding:10px;border-radius:12px;border:1px solid rgba(127,127,127,.35);cursor:pointer;background:transparent;color:inherit;text-align:left}
#${CAS_ID} .c-tr.on{border-color:#2fb35a;background:rgba(47,179,90,.2)}
#${CAS_ID} .c-tr b{display:block;font-size:13px}
#${CAS_ID} .c-tr span{font-size:11.5px;opacity:.7}
#${CAS_ID} .c-tr em{font-style:normal;font-size:20px}
#${CAS_ID} input.c-in,#${CAS_ID} textarea.c-in{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:10px;border:1px solid rgba(127,127,127,.4);background:rgba(0,0,0,.15);color:inherit;font:inherit}
#${CAS_ID} .c-note{font-size:11.5px;opacity:.65;margin-top:4px}
#${CAS_ID} .c-foot{display:flex;gap:6px;align-items:center;padding:10px 16px;border-top:1px solid rgba(127,127,127,.25);flex-wrap:wrap}
#${CAS_ID} .c-btn{padding:8px 14px;border-radius:10px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
#${CAS_ID} .c-btn.go{background:#2fb35a;border-color:#2fb35a;color:#fff;font-weight:700;margin-left:auto}
#${CAS_ID} .c-btn.ghost{border-color:transparent;opacity:.75}`;
      doc.head.appendChild(st);
    }

    function casClose(dismiss) {
      const o = doc.getElementById(CAS_ID);
      if (o) o.remove();
      if (dismiss) casDismissed = true;
      render();
    }

    function casOpen() {
      ned = null;
      casStyle();
      if (!cas) cas = casDefault();
      casDraw();
    }

    function casDraw() {
      let o = doc.getElementById(CAS_ID);
      if (!o) {
        o = el('div', '');
        o.id = CAS_ID;
        o.addEventListener('click', (e) => { if (e.target === o) casClose(true); });
        doc.body.appendChild(o);
      }
      o.replaceChildren();
      const box = el('div', 'c-box');
      const head = el('div', 'c-head');
      head.appendChild(el('div', 'c-gem'));
      const tt = el('div', '');
      tt.appendChild(el('div', 'c-title', cas.edit ? '주민 프로필 수정' : '새 주민 등록'));
      tt.appendChild(el('div', 'c-sub', 'LARKHAVEN · 라크헤이븐에 오신 걸 환영해요'));
      head.appendChild(tt);
      const x = el('button', 'c-x', '✕');
      x.title = '닫기 (상태바의 ✨ 버튼으로 다시 열 수 있어요)';
      x.addEventListener('click', () => casClose(true));
      head.appendChild(x);
      box.appendChild(head);

      const steps = el('div', 'c-steps');
      CAS.steps.forEach((nm, i) => {
        const b = el('button', i === cas.step ? 'on' : i < cas.step ? 'done' : '', `${i + 1}. ${nm}`);
        b.addEventListener('click', () => { cas.step = i; casDraw(); });
        steps.appendChild(b);
      });
      box.appendChild(steps);

      const main = el('div', 'c-main');
      main.appendChild(casCard());
      const pane = el('div', '');
      [casStep0, casStep1, casStep2, casStep3, casStepHome, casStep4][cas.step](pane);
      main.appendChild(pane);
      const scroll = el('div', 'c-scroll');
      if (cas.aiOpen) casAiPane(scroll);
      scroll.appendChild(main);
      box.appendChild(scroll);

      const foot = el('div', 'c-foot');
      const rnd = el('button', 'c-btn', '🎲 랜덤');
      rnd.addEventListener('click', () => { casRandom(); casDraw(); });
      foot.appendChild(rnd);
      const aib = el('button', 'c-btn' + (cas.aiOpen ? ' go' : ''), '🤖 AI 생성');
      aib.addEventListener('click', () => { cas.aiOpen = !cas.aiOpen; casDraw(); });
      foot.appendChild(aib);
      if (cas.step > 0) {
        const prev = el('button', 'c-btn', '◀ 이전');
        prev.addEventListener('click', () => { cas.step -= 1; casDraw(); });
        foot.appendChild(prev);
      }
      const last = cas.step === CAS.steps.length - 1;
      const go = el('button', 'c-btn go', last ? (cas.edit ? '💾 저장' : '✨ 라크헤이븐으로 이사하기') : '다음 ▶');
      go.addEventListener('click', () => {
        if (!last) { cas.step += 1; casDraw(); return; }
        if (!clean(cas.name, 40)) { cas.step = 0; casDraw(); setNotice('이름을 적어 주세요', 4000); return; }
        casApply();
      });
      foot.appendChild(go);
      box.appendChild(foot);
      o.appendChild(box);
    }

    function casAiPane(box) {
      const w = el('div', '');
      w.style.cssText = 'margin:8px 12px;padding:10px 12px;border-radius:12px;background:rgba(127,127,127,.14)';
      w.appendChild(el('h5', '', '🤖 AI로 프로필 만들기'));
      const hint = el('textarea', 'c-in');
      hint.rows = 2;
      hint.placeholder = '원하는 느낌 (선택). 예: 도시에서 도망쳐 온 무뚝뚝한 전직 파티시에';
      hint.value = cas.aiHint || '';
      hint.addEventListener('input', () => { cas.aiHint = hint.value; });
      w.appendChild(hint);
      const ck = (key, label) => {
        const l = el('label', '');
        l.style.cssText = 'display:flex;gap:6px;align-items:flex-start;font-size:12.5px;margin:5px 0;cursor:pointer';
        const c = el('input');
        c.type = 'checkbox';
        c.checked = !!cas[key];
        c.addEventListener('change', () => { cas[key] = c.checked; });
        l.appendChild(c);
        l.appendChild(el('span', '', label));
        w.appendChild(l);
      };
      ck('aiPersona', '내 페르소나 설명을 참고하기');
      ck('aiWorld', '월드인포 · 지금까지의 채팅도 참고하기 (전체 프롬프트를 보내서 토큰이 많이 들어요)');
      ck('aiKeep', '이미 적어 둔 이름과 직접 입력 칸은 그대로 두기');
      const run = el('button', 'c-btn go', cas.aiBusy ? '만드는 중…' : '✨ 만들기');
      run.disabled = !!cas.aiBusy;
      run.addEventListener('click', () => { casAiRun(); });
      w.appendChild(run);
      w.appendChild(el('div', 'c-note', '지금 연결된 AI에 요청을 한 번 보내요. 결과는 각 단계의 "직접 입력" 칸에 채워지고, 고치거나 다시 만들 수 있어요.'));
      box.appendChild(w);
    }

    async function casAiRun() {
      const form = cas;
      const c = stContext();
      if (!form || form.aiBusy) return;
      if (!c || (typeof c.generateRaw !== 'function' && typeof c.generateQuietPrompt !== 'function')) { setNotice('이 실리태번 버전에서는 AI 생성을 쓸 수 없어요', 6000); return; }
      form.aiBusy = true;
      casDraw();
      try {
        let persona = '';
        if (form.aiPersona) {
          try { if (typeof c.substituteParams === 'function') persona = String(c.substituteParams('{{persona}}') || ''); } catch (e) { persona = ''; }
          if (!persona || persona.includes('{{')) { try { persona = String((c.powerUserSettings && c.powerUserSettings.persona_description) || ''); } catch (e) { persona = ''; } }
          persona = persona.replace(/\s+/g, ' ').trim().slice(0, 3000);
        }
        const fixed = [];
        if (form.aiKeep) {
          if (clean(form.name, 40)) fixed.push(`name: ${clean(form.name, 40)}`);
          for (const [k, lab] of [['age', 'age'], ['hair', 'hair'], ['eyes', 'eyes'], ['height', 'height'], ['vibe', 'impression'], ['style', 'style']]) if (cx(k)) fixed.push(`${lab}: ${cx(k)}`);
          if (clean(form.personality, 320)) fixed.push(`personality: ${clean(form.personality, 320)}`);
        }
        const prompt = [
          '[Out of story. Do not continue the roleplay and do not write a <delta> block.]',
          'Create a profile for the player character: a newcomer who has just moved to Larkhaven, a modern seaside town in a cozy slow-burn romance life-sim.',
          clean(form.aiHint, 400) ? `What the player wants: ${clean(form.aiHint, 400)}` : '',
          persona ? `The player's persona description (stay consistent with it): ${persona}` : '',
          fixed.length ? `Already decided, keep exactly: ${fixed.join('; ')}` : '',
          settings.lang === 'ko' ? 'Write every value in Korean (the name may be in any language).' : 'Write every value in English.',
          'Answer with ONE JSON object and nothing else, with these string keys: "name", "pronouns" (she/her or he/him), "age", "height", "hair" (color and style), "eyes", "impression" (how the face reads at first sight), "style" (clothes), "features" (moles, scars, glasses...), "personality" (personality, speech and habits, under 200 characters), "reason" (why they came to town, under 150 characters), "details" (other facts the story must respect, under 200 characters). Keep the other values under 50 characters.',
        ].filter(Boolean).join('\n');
        let out;
        if (form.aiWorld && typeof c.generateQuietPrompt === 'function') out = await c.generateQuietPrompt({ quietPrompt: prompt });
        else if (typeof c.generateRaw === 'function') out = await c.generateRaw({ prompt, systemPrompt: 'You fill in character sheets. Answer with one JSON object and nothing else.' });
        else out = await c.generateQuietPrompt({ quietPrompt: prompt });
        const txt = String(out || '');
        const a = txt.indexOf('{');
        const b = txt.lastIndexOf('}');
        if (a === -1 || b <= a) throw new Error('no JSON in the reply');
        const j = JSON.parse(txt.slice(a, b + 1));
        const str = (v, n) => (typeof v === 'string' || typeof v === 'number' ? clean(String(v), n) : '');
        const put = (key, v, n) => { const t = str(v, n); if (t && !(form.aiKeep && clean(form[key], n))) form[key] = t; };
        put('name', j.name, 40);
        const pr = str(j.pronouns, 30).toLowerCase();
        const std = CAS.pron.find((x) => x[0] === pr);
        if (std) { form.pron = std[0]; form.pronX = ''; } else put('pronX', j.pronouns, 30);
        put('ageX', j.age, 80); put('heightX', j.height, 80); put('hairX', j.hair, 80); put('eyesX', j.eyes, 80);
        put('vibeX', j.impression, 80); put('styleX', j.style, 80); put('memo', j.features, 160);
        put('personality', j.personality, 320); put('whyX', j.reason, 200); put('details', j.details, 400);
        setNotice('AI가 프로필을 채웠어요 — 각 단계에서 확인하고 고쳐 보세요', 5000);
      } catch (e) {
        console.warn('[Larkhaven] AI profile failed', e);
        setNotice('AI 생성에 실패했어요 — 다시 시도하거나 직접 입력해 주세요', 6000);
      } finally {
        form.aiBusy = false;
        if (cas === form && doc.getElementById(CAS_ID)) casDraw();
      }
    }

    function casCard() {
      const c = el('div', 'c-card');
      c.appendChild(el('div', 'c-tag', 'RESIDENT CARD'));
      const ava = el('div', 'c-ava');
      const hc = (CAS.hair.find((h) => h[0] === cas.hair) || CAS.hair[0])[1];
      const ec = (CAS.eyes.find((h) => h[0] === cas.eyes) || CAS.eyes[0])[1];
      ava.style.background = `radial-gradient(circle at 50% 78%, #f3d9c4 0 34%, transparent 35%), radial-gradient(circle at 50% 42%, ${hc} 0 60%, transparent 61%), linear-gradient(160deg, rgba(47,179,90,.35), rgba(0,0,0,.2))`;
      const l = el('i', 'l'); l.style.background = ec; const r = el('i', 'r'); r.style.background = ec;
      ava.appendChild(l); ava.appendChild(r);
      const casPic = okUrl(cas.img) ? cas.img.trim() : personaAvatar();
      if (casPic) { // the player's own photo (or persona picture) replaces the drawn face
        const im = el('img');
        im.referrerPolicy = 'no-referrer';
        im.alt = '';
        im.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:50% 20%;border-radius:inherit;position:absolute;left:0;top:0';
        im.addEventListener('error', () => im.remove());
        im.src = casPic;
        ava.style.position = 'relative'; ava.style.overflow = 'hidden';
        ava.appendChild(im);
      }
      c.appendChild(ava);
      c.appendChild(el('div', 'c-name', clean(cas.name, 40) || '이름 없음'));
      c.appendChild(el('div', 'c-pron', kv(CAS.pron, 'pron')));
      const lines = el('div', 'c-lines');
      lines.appendChild(el('div', '', `👤 ${kv(CAS.age, 'age')} · ${kv(CAS.height, 'height')}`));
      lines.appendChild(el('div', '', `💇 ${kv(CAS.hair, 'hair')} ${kv(CAS.hairStyle, 'hairStyle')} · 👁 ${kv(CAS.eyes, 'eyes')}`));
      lines.appendChild(el('div', '', `✨ ${kv(CAS.vibe, 'vibe')} · 👗 ${kv(CAS.style, 'style')}`));
      const tr = el('div', '');
      tr.appendChild(el('span', '', '🎭 '));
      if (!cas.traits.length) tr.appendChild(el('span', '', '특성 미선택'));
      for (const id of cas.traits) { const t = CAS.traits.find((x) => x[0] === id); if (t) tr.appendChild(el('span', 'c-badge', `${t[1]} ${t[2]}`)); }
      lines.appendChild(tr);
      lines.appendChild(el('div', '', `🧳 ${kv(CAS.why, 'why')}${cv('lean') ? ` · ${kv(CAS.lean, 'lean')}` : ''}`));
      { const h = CAS.home.find((x) => x[0] === cas.home) || CAS.home[0]; lines.appendChild(el('div', '', `🏠 ${h[2]} (${h[3]})`)); }
      if (!cas.edit) lines.appendChild(el('div', '', `🌅 ${kv(CAS.first, 'first')}`));
      c.appendChild(lines);
      return c;
    }

    function casSec(pane, title) { const s = el('div', 'c-sec'); s.appendChild(el('h5', '', title)); pane.appendChild(s); return s; }
    function casChips(sec, list, keyName) {
      const w = el('div', 'c-opts');
      for (const it of list) {
        const b = el('button', 'c-opt' + (cas[keyName] === it[0] ? ' on' : ''), it[it.length - 1]);
        b.addEventListener('click', () => { cas[keyName] = it[0]; casDraw(); });
        w.appendChild(b);
      }
      sec.appendChild(w);
    }
    function casSwatches(sec, list, keyName) {
      const w = el('div', 'c-opts');
      for (const it of list) {
        const b = el('button', 'c-sw' + (cas[keyName] === it[0] ? ' on' : ''));
        b.style.background = it[1];
        b.title = it[2];
        b.addEventListener('click', () => { cas[keyName] = it[0]; casDraw(); });
        w.appendChild(b);
      }
      sec.appendChild(w);
    }
    function casInput(sec, keyName, ph, area) {
      const i = el(area ? 'textarea' : 'input', 'c-in');
      i.placeholder = ph;
      i.value = cas[keyName] || '';
      if (area) i.rows = 2;
      i.addEventListener('input', () => { cas[keyName] = i.value; const card = doc.querySelector(`#${CAS_ID} .c-card`); if (card) card.replaceWith(casCard()); });
      sec.appendChild(i);
    }

    function casCustom(sec, k) { casInput(sec, `${k}X`, '직접 입력 (쓰면 위 선택 대신 이걸로 적용돼요)'); }
    function casStep0(pane) {
      casInput(casSec(pane, '이름'), 'name', '라크헤이븐에서 불릴 이름');
      { const q = casSec(pane, '호칭'); casChips(q, CAS.pron, 'pron'); casCustom(q, 'pron'); }
      { const q = casSec(pane, '나이대'); casChips(q, CAS.age, 'age'); casCustom(q, 'age'); }
      casInput(casSec(pane, '프로필 사진 (비워 두면 내 페르소나 사진을 써요)'), 'img', '다른 사진을 쓰고 싶을 때만: https://… 이미지 주소');
      pane.appendChild(el('div', 'c-note', '이름은 내 페르소나 이름(유저 이름)이 기본으로 들어가요. 이야기는 내가 쓰는 언어로 진행되고, 사진은 지도와 👤 나 탭에 떠요.'));
    }
    function casStep1(pane) {
      const h = casSec(pane, `머리색 · ${kv(CAS.hair, 'hair')}`); casSwatches(h, CAS.hair, 'hair'); casCustom(h, 'hair');
      { const q = casSec(pane, '헤어스타일'); casChips(q, CAS.hairStyle, 'hairStyle'); casCustom(q, 'hairStyle'); }
      const e = casSec(pane, `눈색 · ${kv(CAS.eyes, 'eyes')}`); casSwatches(e, CAS.eyes, 'eyes'); casCustom(e, 'eyes');
      { const q = casSec(pane, '키'); casChips(q, CAS.height, 'height'); casCustom(q, 'height'); }
      { const q = casSec(pane, '분위기'); casChips(q, CAS.vibe, 'vibe'); casCustom(q, 'vibe'); }
      { const q = casSec(pane, '옷 스타일'); casChips(q, CAS.style, 'style'); casCustom(q, 'style'); }
      const m = casSec(pane, '그 밖의 특징 (선택)'); casInput(m, 'memo', '예: 왼쪽 눈 밑 점, 안경, 늘 이어폰을 끼고 다님', true);
    }
    function casStep2(pane) {
      const sec = casSec(pane, `성격 특성 2개 고르기 (${cas.traits.length}/2)`);
      const g = el('div', 'c-trait');
      for (const [id, icon, name, eff] of CAS.traits) {
        const b = el('button', 'c-tr' + (cas.traits.includes(id) ? ' on' : ''));
        b.appendChild(el('em', '', icon)); b.appendChild(el('b', '', name)); b.appendChild(el('span', '', eff));
        b.addEventListener('click', () => {
          if (cas.traits.includes(id)) cas.traits = cas.traits.filter((x) => x !== id);
          else { cas.traits.push(id); if (cas.traits.length > 2) cas.traits.shift(); }
          casDraw();
        });
        g.appendChild(b);
      }
      sec.appendChild(g);
      casInput(casSec(pane, '성격 · 말투 · 행동 (선택, 직접 입력)'), 'personality', '예: 낯가림이 심하지만 친해지면 장난이 많음. 존댓말을 쓰고, 당황하면 말이 빨라짐', true);
      if (cas.edit) pane.appendChild(el('div', 'c-note', '이미 고른 특성은 바꿔도 적용되지 않을 수 있어요(특성은 처음 2개만 남아요).'));
    }
    function casStep3(pane) {
      { const q = casSec(pane, '이 마을에 온 이유'); casChips(q, CAS.why, 'why'); casCustom(q, 'why'); }
      casInput(casSec(pane, '조금 더 (선택)'), 'whyMemo', '예: 전 직장 상사에게서 도망치는 중', true);
      { const q = casSec(pane, '관심 있는 일'); casChips(q, CAS.lean, 'lean'); casCustom(q, 'lean'); }
      casInput(casSec(pane, '꼭 지켜야 할 그 밖의 설정 (선택, 직접 입력)'), 'details', '예: 왼손잡이, 술을 못 마심, 고양이 알레르기, 전직 파티시에', true);
      pane.appendChild(el('div', 'c-note', '어디서 일하는지는 마을에서 "내 편"이 돼요. 정하지 않아도 괜찮아요.'));
    }
    function casStepHome(pane) {
      const sec = casSec(pane, '살 곳 고르기 (월세는 모두 같아요)');
      const g = el('div', 'c-trait');
      for (const [id, icon, name, area, desc] of CAS.home) {
        const b = el('button', 'c-tr' + (cas.home === id ? ' on' : ''));
        b.appendChild(el('em', '', icon)); b.appendChild(el('b', '', `${name} · ${area}`)); b.appendChild(el('span', '', desc));
        b.addEventListener('click', () => { cas.home = id; casDraw(); });
        g.appendChild(b);
      }
      sec.appendChild(g);
      pane.appendChild(el('div', 'c-note', '사는 곳이 곧 동네예요. 이웃이 먼저 말을 걸고, 집에서 쉬거나 꾸미는 효과는 이 집에 적용돼요. 중심가나 공방 거리에 살면 어느 편 동네에 사는지 소문은 나지만, 편이 정해지진 않아요.'));
    }
    function casStep4(pane) {
      if (cas.edit) { pane.appendChild(el('div', 'c-note', '저장하면 프로필만 바뀌고 이야기는 그대로 이어져요.')); return; }
      casChips(casSec(pane, '첫날 아침'), CAS.first, 'first');
      casInput(casSec(pane, '직접 쓰기 (선택, 쓰면 위 선택 대신 이걸로 시작)'), 'firstMemo', '예: 짐은 내팽개치고 바다부터 보러 간다');
      pane.appendChild(el('div', 'c-note', '이사하기를 누르면 프로필이 저장되고 첫 장면이 시작돼요. 나중에 👤 나 탭에서 프로필을 고칠 수 있어요.'));
    }

    async function casApply() {
      const lines = [`name: ${clean(cas.name, 40)}`, `pronouns: ${clean(cv('pron'), 30)}`, `look: ${casLook()}`, `backstory: ${casBackstory()}`, `home: ${cas.home}`];
      if (clean(cas.personality, 320)) lines.push(`personality: ${clean(cas.personality, 320)}`);
      if (clean(cas.details, 400)) lines.push(`details: ${clean(cas.details, 400)}`);
      if (cas.traits.length) lines.push(`trait: ${cas.traits.join(', ')}`);
      const keyRe = /^(name|pronouns|look|backstory|personality|details|trait|home)\s*:/i;
      let ok = false;
      try {
        const arr = await getChatMessages(0);
        const m0 = Array.isArray(arr) ? arr[0] : null;
        if (m0 && typeof m0.message === 'string') {
          const text = m0.message;
          const mm = text.match(/<delta>([\s\S]*?)<\/delta>\s*$/);
          const keep = mm ? mm[1].split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !keyRe.test(x)) : [];
          const body = mm ? text.slice(0, mm.index).replace(/\s+$/, '') : text.replace(/\s+$/, '');
          const next = `${body}\n\n<delta>\n${[...keep, ...lines].join('\n')}\n</delta>`;
          if (typeof setChatMessages === 'function') { await setChatMessages([{ message_id: 0, message: next }], { refresh: 'affected' }); ok = true; }
          else if (typeof setChatMessage === 'function') { await setChatMessage({ message: next }, 0, { refresh: 'display_and_render_current' }); ok = true; }
        }
      } catch (e) { console.warn('[Larkhaven] could not write the profile into the greeting', e); }
      const wasEdit = cas.edit;
      { // remember the form itself (photo, chips, custom boxes) so "edit profile" reopens as it was left
        const f = { ...cas };
        delete f.step; delete f.edit; delete f.aiBusy; delete f.aiOpen;
        formStore = f;
        try { await updateVariablesWith((vars) => { vars.larkhaven_form = f; return vars; }, { type: 'chat' }); } catch (e) { console.warn('[Larkhaven] could not save the profile form', e); }
      }
      const firstText = clean(cas.firstMemo, 200) || cas.first;
      casClose(false);
      if (!ok) {
        // fallback: tell the narrator in a message; it reports the keys itself
        setInput(`[New resident] ${lines.join('; ')}.${wasEdit ? '' : ` First morning: ${firstText}.`} (Report these as delta keys.)`, !wasEdit);
        return;
      }
      if (ckptStore && ckptStore.state) { // the checkpoint skips message 0, so patch the profile into it too
        const pl = ckptStore.state.player;
        Object.assign(pl, { name: clean(cas.name, 40), pronouns: clean(cv('pron'), 30), look: casLook(), backstory: casBackstory(), home: cas.home });
        if (clean(cas.personality, 320)) pl.personality = clean(cas.personality, 320);
        if (clean(cas.details, 400)) pl.details = clean(cas.details, 400);
        if (pl.traits.length < 2) pl.traits = cas.traits.slice(0, 2);
        try { await updateVariablesWith((vars) => { vars.larkhaven_ckpt = ckptStore; return vars; }, { type: 'chat' }); } catch (e) { /* next save retries */ }
      }
      cas = null;
      schedule();
      if (!wasEdit) {
        // speak the player's language from the very first message, so the narrator answers in it
        const pre = CAS.first.find((f) => f[0] === firstText);
        const koText = pre ? pre[1].replace(/^\S+\s+/, '') : firstText;
        setInput(settings.lang === 'ko' ? `(첫날 아침: ${koText}.)` : `(First morning: ${firstText}.)`, true);
      }
      else setNotice('프로필을 저장했어요', 3000);
    }

    function render() {
      const root = ensureUI();
      root.replaceChildren();
      if (!latest) return;
      const s = latest.state;
      const t = s.time;
      const mood = LH.moodOf(s.needs);
      const fest = LH.festivalOf(t);

      /* bar */
      const bar = el('div', 'lh-bar');
      bar.title = '눌러서 자세히 보기';
      bar.appendChild(el('span', 'lh-chip', `${KO.season[t.season]} ${t.day}일 (${KO.weekday[LH.weekday(t)]}) · ${KO.slot[t.slot]}`));
      if (settings.barMode !== 'min') {
        bar.appendChild(el('span', 'lh-chip', KO.weather[s.weather] || s.weather));
        bar.appendChild(el('span', 'lh-chip', `📍 ${KO.district[s.place.district] || s.place.district}`));
      }
      bar.appendChild(el('span', 'lh-chip lh-money', `$${s.money.toLocaleString('en-US')}`));
      if (settings.barMode === 'full') {
        const needs = el('div', 'lh-needs');
        needs.appendChild(needBar('에너지', s.needs.energy));
        needs.appendChild(needBar('배고픔', s.needs.hunger));
        needs.appendChild(needBar('사교', s.needs.social));
        bar.appendChild(needs);
      }
      if (settings.barMode !== 'min') bar.appendChild(el('span', 'lh-chip', `기분 ${KO.mood[mood]}`));
      if (fest && settings.barMode !== 'min') bar.appendChild(el('span', 'lh-chip', `🎉 ${fest}`));
      const notice = noticeText || (!latest.latestAssistantHasDelta ? '마지막 답변에 delta 없음' : '');
      if (notice) bar.appendChild(el('span', 'lh-chip lh-notice', `⚠ ${notice}`));
      if (!s.player.name) {
        const cb = el('span', 'lh-chip lh-notice', '✨ 주민 만들기');
        cb.style.cursor = 'pointer';
        cb.addEventListener('click', (e) => { e.stopPropagation(); casOpen(); });
        bar.appendChild(cb);
      }
      bar.addEventListener('click', () => { panelOpen = !panelOpen; render(); });
      root.appendChild(bar);

      if (!panelOpen) return;

      /* panel */
      const p = el('div', 'lh-panel');
      const tabs = el('div', 'lh-tabs');
      for (const [key, label] of [['town', '🗺️ 마을'], ['act', '👆 행동'], ['rel', '💞 관계'], ['growth', '🌱 성장'], ['home', '🏠 집'], ['achv', '🏆 업적'], ['status', '👤 나'], ['set', '⚙️']]) {
        const b = el('button', panelTab === key ? 'on' : '', label);
        b.addEventListener('click', (e) => { e.stopPropagation(); panelTab = key; render(); });
        tabs.appendChild(b);
      }
      p.appendChild(tabs);
      if (panelTab === 'town') renderTown(p, s);
      else if (panelTab === 'act') renderActions(p, s);
      else if (panelTab === 'set') renderSettings(p, s);
      else if (panelTab === 'rel') renderRelations(p, s);
      else if (panelTab === 'growth') renderGrowth(p, s);
      else if (panelTab === 'home') renderHome(p, s);
      else if (panelTab === 'achv') renderAchievements(p, s);
      else {
      p.appendChild(el('h4', '', '주민 카드'));
      if (playerImg()) {
        const mw = el('div', 'lh-me');
        const im = el('img');
        im.referrerPolicy = 'no-referrer';
        im.alt = '';
        im.addEventListener('error', () => mw.remove());
        im.src = playerImg();
        mw.appendChild(im);
        mw.appendChild(el('b', '', s.player.name || ''));
        p.appendChild(mw);
      }
      row(p, '이름', s.player.name || '아직 없음');
      if (s.player.pronouns) row(p, '호칭', s.player.pronouns);
      row(p, '사는 곳', `${LH.HOMES[LH.homeDistrict(s)].ko} · ${KO.district[LH.homeDistrict(s)] || ''}`);
      if (s.player.look) p.appendChild(el('div', 'lh-note', s.player.look));
      if (s.player.backstory) p.appendChild(el('div', 'lh-note', s.player.backstory));
      if (s.player.personality) p.appendChild(el('div', 'lh-note', `성격: ${s.player.personality}`));
      if (s.player.details) p.appendChild(el('div', 'lh-note', `설정: ${s.player.details}`));
      const ebw = el('div', 'lh-btns');
      const eb = el('button', '', s.player.name ? '✏️ 프로필 수정' : '✨ 주민 만들기');
      eb.addEventListener('click', (e) => { e.stopPropagation(); cas = null; casOpen(); });
      ebw.appendChild(eb);
      p.appendChild(ebw);
      p.appendChild(el('h4', '', '오늘'));
      row(p, '날짜', `${t.year}년차 ${KO.season[t.season]} ${t.day}일 (${KO.weekday[LH.weekday(t)]})`);
      row(p, '시간대', KO.slot[t.slot]);
      row(p, '장소', `${KO.district[s.place.district] || s.place.district} / ${s.place.spot}`);
      if (fest) row(p, '축제', fest);

      p.appendChild(el('h4', '', '돈과 월세'));
      row(p, '소지금', `$${s.money.toLocaleString('en-US')}`);
      const toSun = 6 - LH.weekday(t);
      row(p, '다음 월세', `$${LH.RULES.rent + s.rent.owed} · ${toSun === 0 ? '오늘 밤' : `${toSun}일 뒤 (일요일 밤)`}`);
      if (s.rent.owed) row(p, '밀린 월세', `$${s.rent.owed}`);
      row(p, '연속 납부', `${s.rent.streak}주`);
      for (const l of s.ledger.slice(-5).reverse()) {
        row(p, `${l.date.split(',')[0]} · ${l.reason}`, `${l.amount >= 0 ? '+' : ''}$${l.amount}`);
      }

      p.appendChild(el('h4', '', '캐릭터'));
      row(p, '이름', s.player.name || '—');
      const side = LH.playerSide(s);
      row(p, '진영', side ? `${KO.side[side]}${s.career.current && LH.CAREER[s.career.current].side ? ' (직장)' : ' (소문)'}` : '중립');
      if (s.lean) row(p, '소문 기울기', s.lean > 0 ? `백화점 쪽 ${s.lean}` : `시장 쪽 ${-s.lean}`);
      row(p, '특성', s.player.traits.join(', ') || '—');
      const inv = Object.entries(s.inventory).map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(', ');
      row(p, '소지품', inv || '—');
      if (s.flags.length) row(p, '플래그', s.flags.join(', '));

      p.appendChild(el('h4', '', '진단'));
      row(p, '반영된 답변 수', String(latest.applied));
      if (latest.last && latest.last.deferred.length) {
        row(p, '다음 단계에서 반영될 항목', String(latest.last.deferred.length));
      }
      const lastWarn = latest.allWarnings.slice(-3);
      if (!lastWarn.length) p.appendChild(el('div', 'lh-muted', '경고 없음'));
      for (const w of lastWarn) p.appendChild(el('div', 'lh-warn', `#${w.id}: ${w.warnings.join(' / ')}`));

      }
      const btns = el('div', 'lh-btns');
      const refresh = el('button', '', '다시 계산');
      refresh.addEventListener('click', (e) => { e.stopPropagation(); noticeText = ''; recompute(); });
      const close = el('button', '', '닫기');
      close.addEventListener('click', (e) => { e.stopPropagation(); panelOpen = false; render(); });
      btns.appendChild(refresh);
      btns.appendChild(close);
      p.appendChild(btns);
      root.appendChild(p);
    }

    /* ---------- events ---------- */

    eventOn(tavern_events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
      if (dryRun) return;
      generating = true; genAt = Date.now();
      // For a swipe/regenerate, the reply being replaced must not count.
      const replacing = type === 'swipe' || type === 'regenerate';
      await recompute({ excludeLastAssistant: replacing, persist: false });
    });

    for (const ev of [
      tavern_events.MESSAGE_RECEIVED,
      tavern_events.MESSAGE_SWIPED,
      tavern_events.MESSAGE_EDITED,
      tavern_events.MESSAGE_UPDATED,
      tavern_events.MESSAGE_DELETED,
      tavern_events.CHAT_CHANGED,
      tavern_events.GENERATION_ENDED,
    ]) {
      if (ev) eventOn(ev, () => { noticeText = ''; if (ev === tavern_events.GENERATION_ENDED || ev === tavern_events.MESSAGE_RECEIVED) generating = false; if (ev === tavern_events.CHAT_CHANGED) { parseCache.clear(); savedJson = ''; ckptStore = undefined; formStore = null; customList = []; opsStore = null; generating = false; ned = null; casDismissed = false; cas = null; const o = doc.getElementById(CAS_ID); if (o) o.remove(); } schedule(); });
    }

    for (const ev of [tavern_events.GENERATION_STOPPED]) if (ev) eventOn(ev, () => { generating = false; schedule(); });
    if (tavern_events.GENERATION_STARTED) eventOn(tavern_events.GENERATION_STARTED, (type, _o, dry) => { if (!dry) { generating = true; genAt = Date.now(); } });

    $(window).on('pagehide', () => {
      try { uninjectPrompts([INJECT_ID, SCAN_ID]); } catch (e) { /* ignore */ }
      doc.getElementById(UI_ID)?.remove();
      doc.getElementById(STYLE_ID)?.remove();
    });

    $(() => recompute());
  })();
}

})();
