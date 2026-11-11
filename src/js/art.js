// The Cute Devil: product illustrations (inline SVG, 4:5). Owner: art.
// Accent always comes from var(--c-accent) so the art follows the theme.
import { logoMark } from './logo.js';

const LOGO = logoMark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const A = 'style="fill:var(--c-accent)"';
const AS = 'fill="none" style="stroke:var(--c-accent)"';
const n = (v) => Math.round(v * 100) / 100;

// the real logo mark, placed in a square box
const logo = (x, y, w) => `<svg x="${x}" y="${y}" width="${w}" height="${w}" viewBox="0 0 512 512">${LOGO}</svg>`;

// two small horns; (x, y) is the middle of their base line
const HORN = 'M-7 2C-17-9-15-28 0-37-5-25-1-12 9-3Z';
const horns = (x, y, gap, s, attr = A) =>
  `<g ${attr}><path transform="translate(${x - gap} ${y}) scale(${s})" d="${HORN}"/><path transform="translate(${x + gap} ${y}) scale(${-s} ${s})" d="${HORN}"/></g>`;

// the horned shadow on its own; (x, y) is top centre, h is the height
const devil = (x, y, h, attr = A) => {
  const s = h / 484;
  return `<g transform="translate(${n(x - 256 * s)} ${n(y + 14 * s)}) scale(${n(s)})" ${attr}><path d="M160 140C108 100 120 18 180-14 152 30 172 72 226 94ZM352 140C404 100 392 18 332-14 360 30 340 72 286 94Z"/><path d="M128 252C122 150 176 84 256 84S390 150 384 252L378 310C378 396 330 470 256 470S134 396 134 310Z"/></g>`;
};

const mirror = (s) => `${s}<g transform="translate(400 0) scale(-1 1)">${s}</g>`;
const backdrop = (cy = 240, r = 172, fy = 462, frx = 120) =>
  `<circle cx="200" cy="${cy}" r="${r}" ${A} opacity=".1"/><circle cx="200" cy="${cy}" r="${r - 34}" fill="none" stroke="#FFF4E6" stroke-opacity=".08" stroke-width="1.5"/><ellipse cx="200" cy="${fy}" rx="${frx}" ry="11" fill="#020714" opacity=".45"/>`;
const grad = (id, a, b, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;

const ART = {
  hoodie: () => {
    const sleeve = '<path d="M130 176C94 186 72 212 64 262L44 398C43 410 50 417 60 418L90 421C99 421 104 415 105 406L124 292Z" fill="url(#a-hoodie-g)"/><path d="M46 384L107 392 105 406C104 415 99 421 90 421L60 418C50 417 43 410 44 398Z" fill="#1A2853"/><path d="M124 292L128 200" fill="none" stroke="#141F45" stroke-width="3" stroke-linecap="round" opacity=".7"/>';
    return `<defs>${grad('a-hoodie-g', '#3A51A0', '#243670')}</defs>${backdrop()}
<path d="M128 186C108 100 150 54 200 54S292 100 272 186C246 206 154 206 128 186Z" fill="#2C3F82"/>
${horns(200, 74, 40, 1)}
<path d="M150 78q10 6 20-2M230 76q10 8 20 2" stroke="#FFF4E6" stroke-opacity=".6" stroke-width="1.5" stroke-dasharray="3 2.5" fill="none"/>
${mirror(sleeve)}
<path d="M130 176C152 162 248 162 270 176L286 300 282 430C282 438 276 442 268 442H132C124 442 118 438 118 430L114 300Z" fill="url(#a-hoodie-g)"/>
<path d="M152 178C140 122 164 90 200 90S260 122 248 178C232 194 168 194 152 178Z" fill="#131D42"/>
<path d="M152 178C168 194 232 194 248 178" fill="none" stroke="#4A63B5" stroke-width="5" stroke-linecap="round"/>
<path d="M118 420H282V430C282 438 276 442 268 442H132C124 442 118 438 118 430Z" fill="#1A2853"/>
<path d="M148 346H252L268 408H132Z" fill="#2B3E80" stroke="#182452" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M180 190V226M220 190V220" stroke="#FFF4E6" stroke-width="4" stroke-linecap="round"/><path d="M180 226v8M220 220v8" ${AS} stroke-width="5" stroke-linecap="round"/>
${logo(142, 228, 116)}`;
  },

  tee: () => `<defs>${grad('a-tee-g', '#FFF8EE', '#EBDCC6')}<clipPath id="a-tee-c"><rect x="200" y="150" width="90" height="77"/></clipPath></defs>${backdrop(250, 172, 458, 110)}
<path d="M142 112C162 136 238 136 258 112L330 144 366 220 314 248 296 214V422C296 430 290 434 284 434H116C110 434 104 430 104 422V214L86 248 34 220 70 144Z" fill="url(#a-tee-g)"/>
<path d="M104 214L112 176M296 214L288 176" stroke="#D9C6AB" stroke-width="3" stroke-linecap="round" fill="none"/>
<path d="M104 300C150 318 150 380 104 400ZM296 300C262 330 268 386 296 404Z" fill="#E2D0B6" opacity=".6"/>
<path d="M142 112C162 136 238 136 258 112L247 107C232 124 168 124 153 107Z" fill="#D9C6AB"/>
<g clip-path="url(#a-tee-c)">${devil(246, 172, 96)}</g>
<path d="M214 226H278V276C278 284 272 290 264 290H228C220 290 214 284 214 276Z" fill="#FFF8EE" stroke="#CDB899" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M219 233H273" stroke="#CDB899" stroke-width="1.5" stroke-dasharray="4 3"/>
<rect x="104" y="388" width="8" height="18" ${A}/>
<path d="M104 424H296" stroke="#D9C6AB" stroke-width="1.5" stroke-dasharray="5 4"/>`,

  cap: () => `<defs>${grad('a-cap-g', '#3550A4', '#1F3068')}${grad('a-cap-b', '#1B2A5C', '#101A3D')}</defs>${backdrop(245, 168, 420, 130)}
<path d="M84 318C80 214 132 152 200 152S320 214 316 318C280 300 120 300 84 318Z" fill="url(#a-cap-g)"/>
<path d="M200 152C166 190 154 250 156 303M200 152C234 190 246 250 244 303" fill="none" stroke="#16224C" stroke-width="2.5" opacity=".8"/>
<path d="M120 198C102 228 94 266 94 300" fill="none" stroke="#5B76CC" stroke-width="4" stroke-linecap="round" opacity=".5"/>
<ellipse cx="200" cy="152" rx="14" ry="6" fill="#16224C"/>
<circle cx="122" cy="250" r="4" fill="#16224C"/><circle cx="278" cy="250" r="4" fill="#16224C"/>
${devil(200, 196, 92)}
${devil(200, 196, 92, 'fill="none" stroke="#06122B" stroke-opacity=".35" stroke-width="9" stroke-dasharray="10 12"')}
<path d="M84 318C120 300 280 300 316 318C352 336 366 366 344 384C300 364 100 364 56 384C34 366 48 336 84 318Z" fill="url(#a-cap-b)"/>
<path d="M56 384C100 364 300 364 344 384C338 392 326 396 316 394C270 380 130 380 84 394C74 396 62 392 56 384Z" ${A}/>
<path d="M92 326C130 312 270 312 308 326" fill="none" stroke="#3550A4" stroke-width="2" stroke-dasharray="6 5" opacity=".9"/>`,

  socks: () => {
    const shape = 'M0 0H66V150C66 172 78 184 100 194C140 210 146 256 108 266C70 274 22 258 6 220C0 204 0 188 0 164Z';
    const toe = 'M112 200C142 216 142 258 108 266C92 270 78 268 66 264C96 250 110 228 112 200Z';
    const heel = 'M0 150C0 204 0 204 6 220C24 214 44 196 50 176C30 172 12 164 0 150Z';
    const ribs = '<path d="M0 34H66" stroke="#020714" stroke-opacity=".2" stroke-width="2"/><path d="M11 4V30M22 4V30M33 4V30M44 4V30M55 4V30" stroke="#020714" stroke-opacity=".15" stroke-width="2"/>';
    return `<defs>${grad('a-socks-g', '#FFF8EE', '#E9D9C2', 1, 0)}</defs>${backdrop(250, 172, 452, 130)}
<g transform="translate(76 92) rotate(-7)">
${horns(33, 2, 14, 0.6)}<path d="${shape}" fill="url(#a-socks-g)"/><path d="${toe}" ${A}/><path d="${heel}" ${A}/>${ribs}
<path d="M0 46H66M0 56H66" ${AS} stroke-width="4"/>
${devil(33, 78, 52)}
</g>
<g transform="translate(196 150) rotate(9)">
<path d="${shape}" ${A}/><path d="${shape}" fill="#020714" opacity=".08"/><path d="${toe}" fill="#FFF4E6"/><path d="${heel}" fill="#FFF4E6"/>${ribs}
<path d="M0 46H66M0 56H66" stroke="#FFF4E6" stroke-width="4"/>
${devil(33, 78, 52, 'fill="#FFF4E6"')}
${horns(33, 2, 14, 0.6, 'fill="#FFF4E6"')}
</g>`;
  },

  'perfume-secret': () => `<defs>${grad('a-ps-l', '#E9A23B', '#A8571A')}${grad('a-ps-c', '#22305E', '#0B1330', 1, 0)}</defs>${backdrop(260, 168, 456, 110)}
${horns(200, 104, 20, 1.25)}
<rect x="158" y="100" width="84" height="80" rx="12" fill="url(#a-ps-c)"/>
<rect x="168" y="108" width="8" height="64" rx="4" fill="#fff" opacity=".18"/>
<rect x="176" y="178" width="48" height="36" fill="#D8B56A"/><rect x="176" y="188" width="48" height="5" fill="#A8843E"/>
<rect x="112" y="210" width="176" height="228" rx="22" fill="#FFF4E6" fill-opacity=".16" stroke="#FFF4E6" stroke-opacity=".55" stroke-width="2.5"/>
<path d="M124 258H276V410C276 420 268 428 258 428H142C132 428 124 420 124 410Z" fill="url(#a-ps-l)"/>
<rect x="150" y="280" width="100" height="124" rx="8" fill="#06122B"/>
<rect x="150" y="280" width="100" height="124" rx="8" fill="none" stroke="#D8B56A" stroke-width="2"/>
${logo(160, 286, 80)}
<rect x="172" y="376" width="56" height="5" rx="2.5" fill="#D8B56A"/><rect x="184" y="388" width="32" height="4" rx="2" ${A}/>
<rect x="126" y="226" width="10" height="190" rx="5" fill="#fff" opacity=".28"/>`,

  'perfume-sweet': () => `<defs><radialGradient id="a-pw-l" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#FFD3D9"/><stop offset="1" stop-color="#F58CA0"/></radialGradient></defs>${backdrop(270, 168, 458, 105)}
${horns(200, 124, 17, 1.05)}
<circle cx="200" cy="152" r="36" fill="#FFF4E6"/><path d="M200 116A36 36 0 0 1 200 188A48 36 0 0 0 200 116Z" fill="#E2D0B6"/>
<circle cx="188" cy="140" r="8" fill="#fff" opacity=".8"/>
<rect x="180" y="186" width="40" height="30" fill="#D8B56A"/><rect x="174" y="208" width="52" height="10" rx="4" fill="#A8843E"/>
<circle cx="200" cy="322" r="112" fill="#FFF4E6" fill-opacity=".16" stroke="#FFF4E6" stroke-opacity=".55" stroke-width="2.5"/>
<path d="M103 300A99 99 0 1 0 297 300C262 286 138 314 103 300Z" fill="url(#a-pw-l)"/>
<circle cx="200" cy="336" r="44" fill="#FFF4E6"/><circle cx="200" cy="336" r="38" fill="none" stroke="#F58CA0" stroke-width="1.5" stroke-dasharray="3 4"/>
${devil(200, 304, 60)}
<path d="M122 266C136 238 158 224 180 220" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="7" stroke-linecap="round"/>
<circle cx="262" cy="392" r="6" fill="#fff" opacity=".35"/><circle cx="244" cy="408" r="3.5" fill="#fff" opacity=".35"/>`,

  'perfume-midnight': () => `<defs>${grad('a-pm-g', '#1C2750', '#070B1C', 1, 0)}</defs>${backdrop(255, 168, 458, 90)}
<circle cx="92" cy="150" r="3" fill="#FFF4E6" opacity=".7"/><circle cx="318" cy="118" r="2.5" fill="#FFF4E6" opacity=".6"/><circle cx="300" cy="210" r="2" fill="#FFF4E6" opacity=".5"/><circle cx="110" cy="330" r="2" fill="#FFF4E6" opacity=".5"/>
${horns(200, 76, 17, 1.15)}
<rect x="166" y="72" width="68" height="78" rx="6" ${A}/><rect x="166" y="72" width="68" height="78" rx="6" fill="#020714" opacity=".15"/>
<rect x="174" y="80" width="7" height="62" rx="3.5" fill="#fff" opacity=".3"/>
<rect x="180" y="148" width="40" height="22" fill="#B9C0D0"/><rect x="180" y="156" width="40" height="4" fill="#7E879C"/>
<path d="M148 182C148 174 154 168 162 168H238C246 168 252 174 252 182V430C252 438 246 444 238 444H162C154 444 148 438 148 430Z" fill="url(#a-pm-g)" stroke="#4A5C99" stroke-width="2"/>
<rect x="157" y="180" width="8" height="250" rx="4" fill="#fff" opacity=".16"/>
<path d="M214 228A32 32 0 1 0 226 278A26 26 0 0 1 214 228Z" fill="#FFF4E6"/>
${horns(203, 228, 9, 0.42, 'fill="#FFF4E6"')}
<rect x="148" y="326" width="104" height="12" ${A}/>
<rect x="172" y="358" width="56" height="5" rx="2.5" fill="#FFF4E6" opacity=".85"/><rect x="182" y="372" width="36" height="4" rx="2" fill="#FFF4E6" opacity=".45"/>
${devil(200, 394, 34)}`,

  'perfume-alibi': () => `<defs>${grad('a-pa-l', '#C9D6F2', '#8097C9')}${grad('a-pa-c', '#EEF1F7', '#9BA4B8', 1, 0)}</defs>${backdrop(265, 168, 458, 105)}
${horns(200, 112, 16, 1.05)}
<path d="M174 108H226L236 178H164Z" fill="url(#a-pa-c)"/><path d="M168 150H232L236 178H164Z" fill="#7E879C" opacity=".45"/>
<rect x="184" y="176" width="32" height="26" fill="#B9C0D0"/>
<path d="M152 200H248L294 262V396L248 444H152L106 396V262Z" fill="#FFF4E6" fill-opacity=".16" stroke="#FFF4E6" stroke-opacity=".55" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M118 290H282V392L243 432H157L118 392Z" fill="url(#a-pa-l)"/>
<path d="M152 200L176 262V444M248 200L224 262V444M106 262H294" fill="none" stroke="#FFF4E6" stroke-opacity=".3" stroke-width="1.5"/>
<path d="M118 290H176V432H157L118 392Z" fill="#fff" opacity=".2"/><path d="M224 290H282V392L243 432H224Z" fill="#06122B" opacity=".14"/>
${logo(146, 282, 108)}
<rect x="170" y="400" width="60" height="5" rx="2.5" fill="#06122B" opacity=".75"/><rect x="184" y="412" width="32" height="4" rx="2" ${A}/>`,

  earbuds: () => {
    const bud = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})"><rect x="-8" y="6" width="16" height="64" rx="8" fill="#E9D9C2"/><rect x="-8" y="56" width="16" height="14" rx="7" fill="#B9C0D0"/><circle r="26" fill="#FFF8EE"/><ellipse cx="-22" cy="-4" rx="11" ry="16" ${A}/><circle cx="8" cy="-8" r="6" fill="#fff" opacity=".9"/><circle cx="6" cy="10" r="3" fill="#06122B" opacity=".5"/></g>`;
    return `<defs>${grad('a-eb-g', '#FFF8EE', '#E4D2B8')}</defs>${backdrop(255, 172, 452, 120)}
${bud(104, 96, 18)}<g transform="translate(400 0) scale(-1 1)">${bud(104, 96, 18)}</g>
${horns(200, 214, 46, 1.35)}
<rect x="96" y="206" width="208" height="222" rx="76" fill="url(#a-eb-g)"/>
<path d="M97 290C140 304 260 304 303 290" fill="none" stroke="#C4AF90" stroke-width="3" stroke-linecap="round"/>
<path d="M136 236C150 224 172 218 192 217" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".9"/>
<circle cx="200" cy="314" r="4.5" ${A}/>
${logo(155, 322, 90)}`;
  },

  powerbank: () => `<defs>${grad('a-pb-g', '#2D3F7C', '#141F45', 1, 1)}</defs>${backdrop(250, 172, 456, 100)}
<path d="M176 60C168 46 180 38 174 22M200 54C192 40 208 32 200 14M224 60C216 46 228 38 222 22" ${AS} stroke-width="5" stroke-linecap="round" opacity=".7"/>
<g transform="rotate(-7 200 260)">
${horns(200, 104, 46, 1.5)}
<rect x="112" y="96" width="176" height="336" rx="30" fill="#0B1330"/>
<rect x="106" y="90" width="176" height="336" rx="30" fill="url(#a-pb-g)" stroke="#5B76CC" stroke-opacity=".6" stroke-width="2"/>
<rect x="120" y="112" width="9" height="230" rx="4.5" fill="#fff" opacity=".14"/>
${logo(134, 150, 120)}
<rect x="148" y="298" width="92" height="5" rx="2.5" fill="#FFF4E6" opacity=".7"/>
<g ${A}><circle cx="158" cy="340" r="8"/><circle cx="182" cy="340" r="8"/><circle cx="206" cy="340" r="8"/></g><circle cx="230" cy="340" r="8" fill="#FFF4E6" opacity=".2"/>
<rect x="166" y="394" width="56" height="14" rx="7" fill="#060B1E"/><rect x="176" y="399" width="36" height="4" rx="2" fill="#B9C0D0"/>
</g>`,

  lamp: () => `<defs>${grad('a-lamp-b', '#FFF8EE', '#D9C6AB', 1, 0)}</defs>
<circle cx="200" cy="225" r="190" ${A} opacity=".08"/><circle cx="200" cy="225" r="145" ${A} opacity=".12"/><circle cx="200" cy="225" r="108" ${A} opacity=".2"/>
<ellipse cx="200" cy="456" rx="150" ry="16" ${A} opacity=".28"/><ellipse cx="200" cy="456" rx="74" ry="9" fill="#020714" opacity=".5"/>
${horns(200, 162, 40, 1.9)}
<circle cx="200" cy="230" r="84" ${A}/>
<circle cx="200" cy="230" r="84" fill="#fff" opacity=".16"/><circle cx="200" cy="238" r="58" fill="#fff" opacity=".2"/><circle cx="200" cy="244" r="34" fill="#fff" opacity=".28"/>
<path d="M146 196C156 174 176 162 196 160" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" opacity=".7"/>
<path d="M166 232Q178 244 190 232M210 232Q222 244 234 232" fill="none" stroke="#06122B" stroke-width="5" stroke-linecap="round" opacity=".75"/>
<path d="M188 258Q200 268 212 258" fill="none" stroke="#06122B" stroke-width="4" stroke-linecap="round" opacity=".75"/>
<path d="M148 296H252L266 440C266 448 260 452 252 452H148C140 452 134 448 134 440Z" fill="url(#a-lamp-b)"/>
<path d="M148 296H252L253 308H147Z" ${A} opacity=".55"/>
${devil(200, 340, 62)}
<circle cx="200" cy="426" r="6" fill="#06122B" opacity=".6"/><circle cx="200" cy="426" r="2.5" ${A}/>`,

  cable: () => `<defs>${grad('a-cb-m', '#EEF1F7', '#9BA4B8', 1, 0)}</defs>${backdrop(255, 172, 458, 120)}
<path d="M122 150C122 250 300 190 300 290C300 356 190 372 156 322C128 280 176 232 226 252C276 272 268 352 216 396" fill="none" stroke="#020714" stroke-opacity=".35" stroke-width="16" stroke-linecap="round" transform="translate(5 8)"/>
<path d="M122 150C122 250 300 190 300 290C300 356 190 372 156 322C128 280 176 232 226 252C276 272 268 352 216 396" ${AS} stroke-width="14" stroke-linecap="round"/>
<path d="M122 170C126 236 290 196 294 276" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="3" stroke-linecap="round"/>
<path d="M172 436L196 370 216 396 242 422Z" stroke-linejoin="round" style="fill:var(--c-accent);stroke:var(--c-accent)" stroke-width="8"/>
<rect x="107" y="52" width="30" height="34" rx="7" fill="url(#a-cb-m)"/><rect x="115" y="60" width="14" height="5" rx="2.5" fill="#06122B" opacity=".5"/>
<rect x="100" y="82" width="44" height="64" rx="10" fill="#FFF4E6"/><rect x="100" y="134" width="44" height="12" rx="6" fill="#D9C6AB"/>
${horns(122, 116, 9, 0.55)}
<rect x="278" y="262" width="46" height="62" rx="8" fill="#FFF4E6" transform="rotate(8 300 292)"/>
<g transform="rotate(8 300 292)">${devil(301, 272, 42)}</g>`,
};

const placeholder = () => `${backdrop(240, 172, 448, 100)}${logo(80, 120, 240)}`;

export const artIds = Object.keys(ART);

export function renderArt(artId, { title } = {}) {
  const draw = Object.prototype.hasOwnProperty.call(ART, artId) ? ART[artId] : placeholder;
  const label = String(title || 'The Cute Devil product').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" class="c-art" role="img" aria-label="${label}" focusable="false">${draw()}</svg>`;
}
