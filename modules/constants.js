const DIMS = { w: 32, d: 32, h: 24 };

const PALETTE = [
  { id: 1,  name: 'Grass',         color: '#3dd847' },
  { id: 2,  name: 'Dirt',          color: '#b8643e' },
  { id: 3,  name: 'Stone',         color: '#a8aeb8' },
  { id: 4,  name: 'Wood',          color: '#d4944f' },
  { id: 5,  name: 'Leaves',        color: '#2ac142' },
  { id: 6,  name: 'Sand',          color: '#fce67f' },
  { id: 7,  name: 'Brick',         color: '#f04a38' },
  { id: 8,  name: 'Glass',         color: '#6fe3ff', opacity: 0.45 },
  { id: 9,  name: 'Red',           color: '#ff2626' },
  { id: 10, name: 'Blue',          color: '#2563ff' },
  { id: 11, name: 'Yellow',        color: '#ffd600' },
  { id: 12, name: 'White',         color: '#f4f4f8' },
  { id: 13, name: 'Snow',          color: '#d0e8ff' },
  { id: 14, name: 'Gold Block',    color: '#ffb800', material: 'standard', metalness: 0.85, roughness: 0.2 },
  { id: 15, name: 'Glowstone',     color: '#ffb43d', emissive: '#ff6a00', emissiveIntensity: 0.6 },
  { id: 16, name: 'Obsidian',      color: '#2d1555', material: 'standard', metalness: 0.3, roughness: 0.1 },
  { id: 17, name: 'Rainbow Block', color: '#ff1493', powerup: true },
  { id: 18, name: 'Crystal',       color: '#b39dff', opacity: 0.65, emissive: '#7a4dff', emissiveIntensity: 0.3, material: 'standard', metalness: 0.1, roughness: 0.2, unlockAt: 50, unlockIcon: '💎' },
];

const VALID_TYPES = new Set(PALETTE.map((p) => p.id));

const BLOCK_POINTS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1,
  7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2,
  13: 2,
  14: 5,
  15: 3,
  16: 4,
  17: 5,
  18: 3,
};

const BADGES = [
  { id: 'first_block',     name: 'First Block',    icon: '🏗️', flavour: 'Placed your first block!' },
  { id: 'builder',         name: 'Builder',         icon: '🧱', flavour: 'Placed 10 blocks!' },
  { id: 'architect',       name: 'Architect',       icon: '🏰', flavour: 'Placed 100 blocks!' },
  { id: 'high_scorer',     name: 'High Scorer',     icon: '⭐', flavour: 'Earned 1,000 score points!' },
  { id: 'comboist',        name: 'Comboist',        icon: '⚡', flavour: 'Hit a ×3 combo multiplier!' },
  { id: 'rainbow_placer',  name: 'Rainbow Placer',  icon: '🌈', flavour: 'Placed a Rainbow Block!' },
  { id: 'golden_touch',    name: 'Golden Touch',    icon: '✨', flavour: 'Placed a Gold Block!' },
  { id: 'glowmaster',      name: 'Glowmaster',      icon: '💡', flavour: 'Placed a Glowstone block!' },
  { id: 'shadow_sculptor', name: 'Shadow Sculptor', icon: '🌑', flavour: 'Placed an Obsidian block!' },
  { id: 'material_artist', name: 'Material Artist', icon: '🎨', flavour: 'Used 8+ different block types!' },
  { id: 'crystal_placer',  name: 'Crystal Placer',  icon: '💎', flavour: 'Placed a Crystal Block!' },
  { id: 'streak_3',        name: 'Hot Start',       icon: '🔥', flavour: 'Logged in 3 days in a row!' },
  { id: 'streak_7',        name: 'Week Warrior',     icon: '🗓️', flavour: 'A full week of building!' },
  { id: 'streak_14',       name: 'Fortnight Pro',    icon: '🏆', flavour: 'Two weeks of daily play!' },
  { id: 'streak_30',       name: 'Monthly Master',   icon: '👑', flavour: 'A full month on the block!' },
  { id: 'daily_devotee',   name: 'Daily Devotee',   icon: '🌟', flavour: 'Seven days of block-placing dedication!' },
  { id: 'daily_champion',  name: 'Daily Champion',  icon: '👑', flavour: 'Won the Daily Challenge!' },
  { id: 'speedrunner',     name: 'Speedrunner',     icon: '⚡', flavour: 'Blazing fast block placement!' },
];

const STREAK_BADGE_MILESTONES = [
  { days: 3,  id: 'streak_3' },
  { days: 7,  id: 'streak_7' },
  { days: 14, id: 'streak_14' },
  { days: 30, id: 'streak_30' },
];

const DISASTER_MIN_SECS = 180;
const DISASTER_MAX_SECS = 480;
const DISASTER_USER_ID = -999;
const DISASTER_USERNAME = 'Natural Disaster';
const DISASTER_DEFS = {
  earthquake: { label: 'Earthquake',       icon: '⚡', zoneMin: 8,  zoneMax: 12 },
  eruption:   { label: 'Volcanic Eruption', icon: '🌋', radiusMin: 5, radiusMax: 7 },
  meteor:     { label: 'Meteor Strike',     icon: '☄️', radiusMin: 3, radiusMax: 5 },
};

const SEED_USER_ID = 0;

const STAGING_DEMO_USERS = [
  { username: 'Staging demo Alice', mode: 'classic' },
  { username: 'Staging demo Bob',   mode: 'classic' },
  { username: 'Staging demo spectator — Alice', mode: 'spectate' },
  { username: 'Staging demo spectator — Bob',   mode: 'spectate' },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIMS,
    PALETTE,
    VALID_TYPES,
    BLOCK_POINTS,
    BADGES,
    STREAK_BADGE_MILESTONES,
    DISASTER_MIN_SECS,
    DISASTER_MAX_SECS,
    DISASTER_USER_ID,
    DISASTER_USERNAME,
    DISASTER_DEFS,
    SEED_USER_ID,
    STAGING_DEMO_USERS,
  };
}
