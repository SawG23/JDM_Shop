#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout, exit } = require('process');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const root = process.cwd();
const configPath = path.join(root, 'config', 'default.yml');
const mirrorPath = path.join(root, 'data', 'static', 'products.yml');
const imageDir = path.join(root, 'frontend', 'src', 'assets', 'public', 'images', 'products');
const distImageDir = path.join(root, 'frontend', 'dist', 'frontend', 'assets', 'public', 'images', 'products');

const curlBinary = process.platform === 'win32' ? 'curl.exe' : 'curl';
const wgetBinary = process.platform === 'win32' ? 'wget.exe' : 'wget';
const wikiHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const manualImageUrlMap = {
  'Mitsubishi 3000GT VR-4': 'https://upload.wikimedia.org/wikipedia/commons/8/83/Mitsubishi_3000GT_--_03-21-2012.JPG',
  'Bucket seat': 'https://cdn.shopify.com/s/files/1/0203/5038/articles/ZILLA_JDM_Bucket_Seat-6_2048x.JPG?v=1508792156',
  'Shift knob': 'https://www.coolshiftknobs.com/wp-content/uploads/2023/03/40e915bdd9f4cfa58fe95289bd47b61.jpg',
  'Oil cooler': 'https://www.greddy.com/cdn/shop/files/12064609_WK01s.jpg?v=1712124038&width=2048',
  'Garage sign': 'https://makerworld.bblmw.com/makerworld/model/USa2c426c4830b20/design/2025-02-16_e33a82b21588e.jpeg',
  'Toyota Chaser JZX100': 'https://jzx100.ru/slides/slide6-stance-black-chaser-jzx100.jpg',
  'Nissan Stagea Autech': 'https://static1.hotcarsimages.com/wordpress/wp-content/uploads/2022/07/stagea-white.jpg',
  'Exhaust system': 'https://bulletproofautomotive.com/wp-content/uploads/2024/05/full-titanium-muffler-kit-expreme-ti-evo7-9-jdm-bumper.jpg',
  'Suspension (vehicle)': 'https://store.supashock.com/cdn/shop/articles/Nissan-Silvia-S13-S14-S15-Coilovers-Dampers-Suspension-Shock-Absorbers-1080x1080-2-603187_1024x1024_050a89f4-2e78-46ac-a8a2-7a66880b949a.jpg?v=1685684376&width=940',
  'Intercooler': 'https://www.jdmgarage.com.au/wp-content/uploads/2022/09/633173F3-0657-4042-8F05-963FFAD985E5.jpg',
  'Body kit': 'https://www.sd-carbon.com/wp-content/uploads/2025/01/Porsche-Panamera-971.1-TA-Style-Wide-Body-Kit-1-1024x1024.jpg',
  'Carbon fiber': 'https://ueeshop.ly200-cdn.com/u_file/UPAY/UPAY469/2401/11/photo/JDMStyleCarbonFiberDoorSillForNissanR35GTR2008-20198.jpg',
  'Strut bar': 'https://jspecauto.s3.amazonaws.com/wp-content/uploads/2024/06/dsc-0001-used-clean-jdm-02-07-subaru-impreza-wrx-sti-oem-front-titanium-strut-bar-for-sale-scaled.jpg',
  'Automotive gauge': 'https://www.jdmgarage.co.nz/cdn/shop/files/screenshot2023-06-13at40713pm.png?v=1687874319&width=1445',
  'Racing harness': 'https://upload.wikimedia.org/wikipedia/commons/3/33/Lotus_22_inside_detail.jpg',
  'Steering wheel': 'https://upload.wikimedia.org/wikipedia/commons/1/11/Steering_wheels_from_different_periods.jpg'
};

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function inferExtension(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length <= 5) {
      return ext;
    }
  } catch {
    // fall back below
  }

  return '.jpg';
}

function isLikelyImageFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 4) {
    return false;
  }

  const header = buffer.subarray(0, 12);
  const isJpeg = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
  const isGif = header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a';
  const isWebp = header.toString('ascii', 0, 4) === 'RIFF' && buffer.length >= 12 && header.toString('ascii', 8, 12) === 'WEBP';
  const isBmp = header[0] === 0x42 && header[1] === 0x4D;

  return isJpeg || isPng || isGif || isWebp || isBmp;
}

function getProductImageTargets(imageName) {
  return [
    path.join(imageDir, imageName),
    path.join(distImageDir, imageName)
  ];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: wikiHeaders, redirect: 'follow' });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`Request failed ${response.status} ${response.statusText} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function askManualImageUrl(rl, query) {
  while (true) {
    const answer = (await rl.question(`[Input] Không tìm thấy ảnh thật cho: ${query}\nNhập direct URL ảnh cho ${query}: `)).trim();

    if (answer) {
      try {
        const url = new URL(answer);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return answer;
        }
      } catch {
        console.warn('[Cảnh báo] URL không hợp lệ, hãy nhập lại.');
        continue;
      }
      console.warn('[Cảnh báo] Chỉ chấp nhận direct URL http/https.');
      continue;
    }

    console.warn('[Cảnh báo] URL không được để trống. Hãy nhập đường dẫn ảnh trực tiếp.');
  }
}

async function resolveImageUrl(query, rl) {
  if (manualImageUrlMap[query]) {
    return manualImageUrlMap[query];
  }

  const fallbackQueries = {
    'Nissan GT-R R35': ['Nissan GT-R'],
    'Toyota Supra MK4': ['Toyota Supra'],
    'Mazda RX-7 FD': ['Mazda RX-7'],
    'Honda NSX NA1': ['Honda NSX', 'Acura NSX'],
    'Subaru Impreza WRX STI GC8': ['Subaru Impreza WRX STI'],
    'Mitsubishi Lancer Evolution VI Tommi Makinen': ['Mitsubishi Lancer Evolution VI Tommi Makinen Edition', 'Lancer Evolution VI'],
    'Nissan Silvia S15 Spec-R': ['Nissan Silvia S15', 'Nissan Silvia'],
    'Toyota AE86 Trueno': ['Toyota Sprinter Trueno AE86', 'Toyota Corolla AE86'],
    'Honda Civic Type R EK9': ['Honda Civic Type R', 'Civic Type R EK9'],
    'Mazda MX-5 NA': ['Mazda MX-5 (NA)', 'Mazda MX-5'],
    'Nissan Skyline GT-R R32': ['Nissan Skyline GT-R', 'Nissan Skyline'],
    'Toyota Chaser JZX100': ['Toyota Chaser'],
    'Lexus LFA': ['Lexus LFA'],
    'Toyota GR86': ['Toyota GR86', 'Toyota 86'],
    'Nissan Fairlady Z Z33': ['Nissan Fairlady Z', 'Nissan 350Z'],
    'Mazda RX-8 Spirit R': ['Mazda RX-8'],
    'Mitsubishi 3000GT VR-4': ['Mitsubishi 3000GT'],
    'Honda Integra Type R DC2': ['Honda Integra Type R'],
    'Nissan Stagea Autech': ['Nissan Stagea'],
    'Toyota Altezza RS200': ['Toyota Altezza'],
    'Turbocharger': ['Turbo'],
    'Intercooler': ['Car intercooler'],
    'Exhaust system': ['Muffler'],
    'Coilover': ['Suspension (vehicle)'],
    'Bucket seat': ['Racing seat'],
    'Alloy wheel': ['Wheel'],
    'Shift knob': ['Gear stick'],
    'Strut bar': ['Strut tower brace'],
    'Brake caliper': ['Brake'],
    'Engine control unit': ['Electronic control unit'],
    'Oil cooler': ['Engine oil cooler'],
    'Body kit': ['Wide body kit'],
    'Carbon fiber': ['Carbon fiber reinforced polymer'],
    'Automotive gauge': ['Gauge'],
    'Racing harness': ['Seat belt'],
    'Steering wheel': ['Steering wheel'],
    'Spoiler (car)': ['Car spoiler'],
    'Tire': ['Tire'],
    'Exhaust manifold': ['Exhaust manifold'],
    'Radiator': ['Radiator'],
    'Side mirror': ['Side mirror'],
    'Garage sign': ['Garage'],
    'Sticker': ['Sticker']
  };

  const candidates = [query, ...(fallbackQueries[query] || [])];

  for (const candidate of candidates) {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`;
    try {
      const summary = await fetchJson(summaryUrl);
      const imageUrl = summary?.originalimage?.source || summary?.thumbnail?.source;
      if (imageUrl) {
        return imageUrl;
      }
    } catch {
      // try next candidate
    }

    await delay(125);
  }

  for (const candidate of candidates) {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(candidate)}&srlimit=1&format=json`;
    try {
      const search = await fetchJson(searchUrl);
      const title = search?.query?.search?.[0]?.title;
      if (!title) {
        continue;
      }

      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const summary = await fetchJson(summaryUrl);
      const imageUrl = summary?.originalimage?.source || summary?.thumbnail?.source;
      if (imageUrl) {
        return imageUrl;
      }
    } catch {
      // try next candidate
    }

    await delay(125);
  }

  for (const candidate of candidates) {
    const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(candidate)}&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url&format=json`;
    try {
      const commons = await fetchJson(commonsUrl);
      const pages = commons?.query?.pages ? Object.values(commons.query.pages) : [];
      const imageUrl = pages[0]?.imageinfo?.[0]?.url;
      if (imageUrl) {
        return imageUrl;
      }
    } catch {
      // try next candidate
    }

    await delay(125);
  }

  return askManualImageUrl(rl, query);
}

function downloadWithCurlOrWget(url, destination) {
  const curl = spawnSync(curlBinary, ['-fsSL', '-L', url, '-o', destination], { stdio: 'inherit' });
  if (curl.status === 0) {
    return;
  }

  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { force: true });
  }

  const wget = spawnSync(wgetBinary, ['-q', '-O', destination, url], { stdio: 'inherit' });
  if (wget.status === 0) {
    return;
  }

  throw new Error(`Failed to download ${url} using curl or wget`);
}

async function downloadOrAskManualUrl(rl, template, destination) {
  let currentUrl = template.imageUrl;

  while (true) {
    try {
      downloadWithCurlOrWget(currentUrl, destination);
      if (isLikelyImageFile(destination)) {
        return currentUrl;
      }

      if (fs.existsSync(destination)) {
        fs.rmSync(destination, { force: true });
      }

      console.warn(`[Cảnh báo] File tải về không phải ảnh hợp lệ cho: ${template.imageQuery}`);
      console.warn(`[Cảnh báo] URL hiện tại: ${currentUrl}`);
      currentUrl = await askManualImageUrl(rl, template.imageQuery);
    } catch (error) {
      if (fs.existsSync(destination)) {
        fs.rmSync(destination, { force: true });
      }

      console.warn(`[Cảnh báo] Không thể tải ảnh cho: ${template.imageQuery}`);
      console.warn(`[Cảnh báo] URL hiện tại: ${currentUrl}`);
      console.warn(`[Cảnh báo] Lý do: ${error.message}`);
      currentUrl = await askManualImageUrl(rl, template.imageQuery);
    }
  }
}

function syncImageToBuildOutput(sourcePath, targetPaths) {
  for (const targetPath of targetPaths) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

const templateRows = [
  ['Nissan GT-R R35 Premium', 'Twin-turbo street monster built for brutal launches and high-speed pulls.', 129999.0, 'Nissan GT-R R35'],
  ['Toyota Supra MK4 Twin Turbo', 'Legendary 2JZ coupe with endless tuning headroom and instant respect.', 114999.0, 'Toyota Supra MK4'],
  ['Mazda RX-7 FD Spirit R', 'Lightweight rotary icon with a sharp chassis and timeless lines.', 98999.0, 'Mazda RX-7 FD'],
  ['Honda NSX NA1', 'Mid-engine precision machine that feels engineered by a surgeon.', 159999.0, 'Honda NSX NA1'],
  ['Subaru Impreza WRX STI GC8', 'Homologation hero with rally pedigree and a boxer rumble.', 44999.0, 'Subaru Impreza WRX STI GC8'],
  ['Mitsubishi Lancer Evolution VI Tommi Makinen', 'Stage-ready turbo sedan tuned for grip, boost, and late braking.', 54999.0, 'Mitsubishi Lancer Evolution VI Tommi Makinen'],
  ['Nissan Silvia S15 Spec-R', 'Drift-ready chassis with sleek styling and perfect street presence.', 68999.0, 'Nissan Silvia S15 Spec-R'],
  ['Toyota AE86 Trueno', 'Lively lightweight coupe made for corners, slides, and weekend canyon runs.', 42999.0, 'Toyota AE86 Trueno'],
  ['Honda Civic Type R EK9', 'Rev-happy hatch with razor-sharp response and legendary balance.', 37999.0, 'Honda Civic Type R EK9'],
  ['Mazda MX-5 Miata NA Roadster', 'Open-top lightweight favorite for pure driving joy on every road.', 29999.0, 'Mazda MX-5 NA'],
  ['Nissan Skyline GT-R R32', 'The original Godzilla with all-wheel grip and boxy turbo attitude.', 89999.0, 'Nissan Skyline GT-R R32'],
  ['Toyota Chaser JZX100 Tourer V', 'Four-door drift weapon with turbo power and sleeper looks.', 45999.0, 'Toyota Chaser JZX100'],
  ['Lexus LFA V10', 'Exotic Japanese supercar with a screaming engine and surgical precision.', 799999.0, 'Lexus LFA'],
  ['Toyota GR86 Track Edition', 'Modern balanced coupe made for tight lines and affordable laps.', 35999.0, 'Toyota GR86'],
  ['Nissan Fairlady Z Z33', 'Nose-heavy grand tourer with a muscular V6 and bold proportions.', 48999.0, 'Nissan Fairlady Z Z33'],
  ['Mazda RX-8 Spirit R', 'Four-door rotary coupe with playful handling and high-rev character.', 38999.0, 'Mazda RX-8 Spirit R'],
  ['Mitsubishi 3000GT VR-4', 'Tech-laden 90s flagship with twin turbos and active aero swagger.', 57999.0, 'Mitsubishi 3000GT VR-4'],
  ['Honda Integra Type R DC2', 'Front-drive scalpel with a famous chassis and screaming VTEC pull.', 61999.0, 'Honda Integra Type R DC2'],
  ['Nissan Stagea Autech', 'Turbo wagon sleeper with skyline vibes and family-hauling practicality.', 52999.0, 'Nissan Stagea Autech'],
  ['Toyota Altezza RS200', 'High-rev sedan with sharp steering and clean street style.', 31999.0, 'Toyota Altezza RS200'],
  ['HKS GT2 Supercharger Kit', 'Bolt-on boost package for serious street power and fast spool.', 8499.0, 'Turbocharger'],
  ['Tomei Turbo Manifold', 'High-flow manifold designed to wake up your favorite inline-six.', 1899.0, 'Exhaust manifold'],
  ['Blitz Blow-Off Valve', 'Classic turbo sound upgrade for pressure relief and style points.', 399.0, 'Turbocharger'],
  ['Fujitsubo Exhaust System', 'Refined stainless exhaust with a deep note and clean finish.', 1299.0, 'Exhaust system'],
  ['TRD Suspension Set', 'Street and track suspension package tuned for tighter body control.', 2199.0, 'Suspension (vehicle)'],
  ['GReddy Intercooler', 'Front-mount cooling upgrade for stable boost and repeat pulls.', 1099.0, 'Intercooler'],
  ['VeilSide Fortune Widebody Kit', 'Aggressive aero kit that turns any build into a showpiece.', 6999.0, 'Body kit'],
  ['Rocket Bunny Aero Kit', 'Wide stance bodywork for instant drift-culture credibility.', 5799.0, 'Body kit'],
  ['Top Secret Carbon Hood', 'Lightweight carbon panel that sharpens looks and sheds mass.', 1899.0, 'Carbon fiber'],
  ['Rays Volk TE37 Wheels', 'Forged six-spoke wheel set loved by racers and street builders alike.', 2899.0, 'Alloy wheel'],
  ['BBS LM Wheels', 'Split-spoke classics for a premium stance with motorsport roots.', 3199.0, 'Alloy wheel'],
  ['Bride Zeta IV Bucket Seat', 'Supportive fixed-back seat for drifting, grip, and posture.', 1499.0, 'Bucket seat'],
  ['Recaro Pole Position Seat', 'Track-focused seat with excellent support and a clean cockpit feel.', 1399.0, 'Bucket seat'],
  ['Nismo Shift Knob', 'Crisp weighted shifter upgrade with factory-plus vibes.', 249.0, 'Shift knob'],
  ['Mugen S2000 Aero Mirrors', 'Slim mirror set inspired by old-school Japanese tuner styling.', 499.0, 'Side mirror'],
  ['Koyorad Aluminum Radiator', 'Cooling upgrade built to keep boosted builds stable under heat.', 799.0, 'Radiator'],
  ['Cusco Strut Tower Bar', 'Chassis brace that adds rigidity and confidence in fast corners.', 349.0, 'Strut bar'],
  ['Endless Brake Kit', 'High-performance braking package for repeated hard stops.', 2499.0, 'Brake caliper'],
  ['Defi Gauge Pod', 'Clean gauge mount for boost, oil, and temperature monitoring.', 299.0, 'Automotive gauge'],
  ['Takata 6-Point Harness', 'Motorsport harness for secure seating and track-day confidence.', 599.0, 'Racing harness'],
  ['Spoon Sports Steering Wheel', 'Small-diameter wheel with a racing feel and subtle style.', 449.0, 'Steering wheel'],
  ['Work Equip 05 Wheels', 'Period-correct wheels that fit resto-mod and stance builds perfectly.', 2799.0, 'Alloy wheel'],
  ['HKS Hi-Power Muffler', 'Iconic exhaust tip and a deep tone for classic tuner builds.', 999.0, 'Exhaust system'],
  ['Apexi Power FC ECU', 'Standalone engine management for dialing in custom maps.', 1599.0, 'Engine control unit'],
  ['Greddy Oil Cooler', 'Extra cooling capacity for hard driving and hot summer traffic.', 899.0, 'Oil cooler'],
  ['JDM Garage Sign', 'Retro wall sign for a workshop, man cave, or showroom corner.', 149.0, 'Garage sign'],
  ['Osaka Drift Decal', 'Street decal pack that gives any build a sharper visual edge.', 39.0, 'Sticker'],
  ['Yokohama ADVAN Tires', 'Sticky performance rubber for traction, grip, and confidence.', 1199.0, 'Tire'],
  ['SSR Professor SP1 Wheels', 'Deep-lip wheel set popular with show builds and clean fitment.', 2999.0, 'Alloy wheel']
];

const templates = templateRows.map(([name, description, price, imageQuery]) => ({
  name,
  description,
  price,
  imageQuery,
  imageUrl: null
}));

async function main() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing expected file: ${configPath}`);
  }

  fs.mkdirSync(imageDir, { recursive: true });
  fs.mkdirSync(distImageDir, { recursive: true });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    for (const template of templates) {
      template.imageUrl = await resolveImageUrl(template.imageQuery, rl);
      await delay(100);
    }

    const source = fs.readFileSync(configPath, 'utf8');
    const productsMatch = source.match(/^products:\n([\s\S]*?)^memories:/m);

    if (!productsMatch) {
      throw new Error('Could not locate the products block in config/default.yml');
    }

    const productsDocument = yaml.load(`products:\n${productsMatch[1]}`);

    if (!productsDocument || !Array.isArray(productsDocument.products)) {
      throw new Error('Failed to parse products from config/default.yml');
    }

    productsDocument.products.forEach((product, index) => {
      const template = templates[index % templates.length];
      const imageExtension = inferExtension(template.imageUrl);
      const imageName = `jdm-${String(index + 1).padStart(2, '0')}-${slugify(template.name)}${imageExtension}`;
      const imagePath = path.join(imageDir, imageName);

      product.name = template.name;
      product.description = template.description;
      product.price = template.price;
      product.image = imageName;
    });

    for (const [index, product] of productsDocument.products.entries()) {
      const template = templates[index % templates.length];
      const [srcImagePath, distImagePath] = getProductImageTargets(product.image);
      const validatedImageUrl = await downloadOrAskManualUrl(rl, template, srcImagePath);

      if (srcImagePath !== distImagePath) {
        syncImageToBuildOutput(srcImagePath, [distImagePath]);
      }

      template.imageUrl = validatedImageUrl;
    }

    const dumpedProducts = yaml.dump(productsDocument, {
      noRefs: true,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "'"
    }).trimEnd();

    const updatedConfig = source
      .replace(/^products:\n[\s\S]*?(?=^memories:)/m, `${dumpedProducts}\n`)
      .replace(/^  name: 'OWASP Juice Shop'$/m, "  name: 'JDM Shop'")
      .replace(/^  theme: .*$/m, '  theme: neon-fire');

    fs.writeFileSync(configPath, updatedConfig, 'utf8');
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, `${dumpedProducts}\n`, 'utf8');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  exit(1);
});

