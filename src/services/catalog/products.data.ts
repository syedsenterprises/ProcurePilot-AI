import { Product } from '@/types/product';

export const SAMPLE_PRODUCTS: Product[] = [
  // 1. Herman Miller Aeron Chair
  {
    id: 'prod-hm-aeron-01',
    sku: 'HM-AER-B-GR',
    name: 'Herman Miller Aeron Ergonomic Chair (Size B)',
    brand: 'Herman Miller',
    category: 'Ergonomics',
    tier: 'Flagship',
    price: 1295.0,
    currency: 'USD',
    shortDescription: 'The gold standard benchmark for ergonomic health and posture alignment.',
    description: 'Engineered with 8Z Pellicle breathable suspension mesh that distributes weight evenly and eliminates heat buildup. Features PostureFit SL sacral support and fully adjustable padded 4D armrests.',
    specifications: {
      'Mechanism': 'Harmonic 2 Tilt with Forward Angle',
      'Material': 'Recycled OceanBound 8Z Pellicle Elastomeric Mesh',
      'Weight Capacity': '350 lbs (159 kg)',
      'Adjustability': 'Height, Seat Angle, Tilt Limiter, 4D Arms, Sacral/Lumbar Pad',
      'Warranty': '12-Year 3-Shift 24/7 Manufacturer Warranty',
      'Certifications': 'Cradle to Cradle V3 Silver, BIFMA Level 3'
    },
    features: [
      'Patented PostureFit SL independent sacral pads',
      'Breathable Pellicle membrane dissipates body heat',
      'Forward tilt function optimal for intensive typing',
      '91% recyclable construction'
    ],
    inStock: true,
    stockCount: 18,
    leadTimeDays: 3,
    rating: 4.9,
    reviewCount: 342,
    imageUrl: 'https://images.unsplash.com/photo-1580481077195-c3a82da91d9b?auto=format&fit=crop&w=800&q=80',
    badge: 'Ergonomic Choice',
    tags: ['chair', 'ergonomics', 'office', 'herman miller', 'seating']
  },

  // 2. Apple MacBook Pro 16" M3 Max
  {
    id: 'prod-apple-mbp-16',
    sku: 'APL-MBP16-M3X-36G',
    name: 'Apple MacBook Pro 16" (M3 Max, 36GB, 1TB)',
    brand: 'Apple',
    category: 'Computing',
    tier: 'Flagship',
    price: 3499.0,
    currency: 'USD',
    shortDescription: 'Uncompromised workstation computing power for heavy software engineering and AI compilation.',
    description: 'Equipped with the 14-core CPU and 30-core GPU M3 Max chip, 36GB Unified Memory, and a stunning 16.2-inch Liquid Retina XDR display with 1600 nits peak brightness and ProMotion 120Hz.',
    specifications: {
      'Processor': 'Apple M3 Max (14-Core CPU, 30-Core GPU, 16-Core Neural Engine)',
      'Memory': '36GB Unified Memory (300GB/s bandwidth)',
      'Storage': '1TB NVMe PCIe 4.0 SSD',
      'Display': '16.2" Liquid Retina XDR (3456x2234, 120Hz ProMotion, 1000 nits sustained)',
      'Battery Life': 'Up to 22 hours video playback (100Wh lithium-polymer)',
      'Ports': '3x Thunderbolt 4, HDMI 2.1, SDXC slot, MagSafe 3, 3.5mm headphone jack'
    },
    features: [
      'Hardware-accelerated ray tracing and mesh shading',
      'Six-speaker sound system with force-cancelling woofers',
      'MagSafe 3 fast-charge capable up to 50% in 30 minutes',
      'Studio-quality 3-mic directional array'
    ],
    inStock: true,
    stockCount: 12,
    leadTimeDays: 2,
    rating: 4.9,
    reviewCount: 520,
    imageUrl: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['laptop', 'macbook', 'apple', 'developer', 'm3 max', 'workstation']
  },

  // 3. Jarvis Dual-Motor Bamboo Standing Desk
  {
    id: 'prod-jarvis-desk-60',
    sku: 'FKY-JRV-6030-BAM',
    name: 'Fully Jarvis Executive Bamboo Standing Desk (60" x 30")',
    brand: 'Fully / Herman Miller',
    category: 'Ergonomics',
    tier: 'Mid-Tier',
    price: 649.0,
    currency: 'USD',
    shortDescription: 'Sustainable solid bamboo surface with dual high-torque whisper-quiet lift motors.',
    description: 'Crafted with sustainably harvested 100% Moso bamboo with a polyurethane UV-cured water-resistant coating. Features programmable memory handset with 4 presets and anti-collision collision sensors.',
    specifications: {
      'Dimensions': '60" W x 30" D x 0.75" Thick Top',
      'Height Range': '24.5" to 50" (including desktop)',
      'Lift Capacity': '350 lbs (dual motor synchronized)',
      'Sound Level': 'Under 48 decibels during transition',
      'Control Handset': 'OLED digital display with 4 memory presets',
      'Frame Warranty': '15-Year structural and motor coverage'
    },
    features: [
      'Whisper-quiet dual motors (< 48dB operation)',
      'Sensitive anti-collision gyroscope sensors',
      'Pre-drilled mounting holes for modular cable trays',
      'FSC-certified sustainable bamboo'
    ],
    inStock: true,
    stockCount: 25,
    leadTimeDays: 4,
    rating: 4.8,
    reviewCount: 280,
    imageUrl: 'https://images.unsplash.com/photo-1595515106969-1ce29566ff1c?auto=format&fit=crop&w=800&q=80',
    badge: 'Top Value',
    tags: ['desk', 'standing desk', 'bamboo', 'ergonomics', 'office']
  },

  // 4. Dell UltraSharp 32" 6K Monitor
  {
    id: 'prod-dell-u3224kb',
    sku: 'DEL-U3224KB-6K',
    name: 'Dell UltraSharp 32" 6K Monitor (U3224KB)',
    brand: 'Dell',
    category: 'Displays',
    tier: 'Enterprise',
    price: 2559.0,
    currency: 'USD',
    shortDescription: 'Massive 6K workspace resolution with integrated 4K HDR webcam and 140W Thunderbolt 4 hub.',
    description: 'The premier professional monitor featuring IPS Black panel technology with 2000:1 contrast ratio, 6144 x 3456 resolution, dual 14W speakers, dual-mic array, and single-cable 140W USB-C Power Delivery.',
    specifications: {
      'Screen Size': '31.5" IPS Black Anti-Glare 16:9',
      'Resolution': '6K UHD (6144 x 3456) at 60Hz',
      'Color Gamut': '99% DCI-P3, 100% sRGB, 1.07 Billion Colors (Delta E < 2)',
      'Webcam': 'Integrated 4K Dual-Gain HDR Sony STARVIS sensor with Auto-Framing',
      'Connectivity': 'Thunderbolt 4 (140W PD, Daisy chain), HDMI 2.1, Mini-DP 2.1, 2.5GbE RJ45',
      'Audio': 'Dual 14W noise-cancelling echo-free speakers'
    },
    features: [
      'Exceptional pixel density (223 PPI) identical to high-end laptops',
      'Integrated auto-shutter 4K webcam with AI framing',
      'Internal KVM switch allowing seamless dual-PC operation',
      'Full height, swivel, tilt, and pivot adjustability'
    ],
    inStock: true,
    stockCount: 8,
    leadTimeDays: 3,
    rating: 4.7,
    reviewCount: 94,
    imageUrl: 'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['monitor', 'display', '6k', 'dell', 'thunderbolt', 'screen']
  },

  // 5. Lenovo ThinkPad X1 Carbon Gen 12
  {
    id: 'prod-lenovo-x1c-g12',
    sku: 'LNV-X1C12-155H-32',
    name: 'Lenovo ThinkPad X1 Carbon Gen 12 (Core Ultra 7)',
    brand: 'Lenovo',
    category: 'Computing',
    tier: 'Flagship',
    price: 1849.0,
    currency: 'USD',
    shortDescription: 'Ultralight enterprise carbon fiber laptop with dedicated neural processing unit.',
    description: 'Weighing just 2.42 lbs (1.09 kg), the ThinkPad X1 Carbon is powered by Intel Core Ultra 7 155H with integrated Intel AI Boost NPU, 32GB LPDDR5x RAM, and a vivid 14" 2.8K OLED display.',
    specifications: {
      'Processor': 'Intel Core Ultra 7 155H (16 Cores, 22 Threads, up to 4.8 GHz)',
      'NPU': 'Intel AI Boost Integrated NPU Engine',
      'Memory': '32GB LPDDR5x-6400MHz',
      'Storage': '1TB SSD M.2 2280 PCIe Gen4 Performance TLC Opal',
      'Display': '14.0" 2.8K (2880 x 1800) OLED, Anti-Reflective, 120Hz, 400 nits, HDR 500',
      'Weight': '2.42 lbs (1.09 kg) Aerospace-grade Carbon Fiber & Recycled Magnesium'
    },
    features: [
      'Legendary spill-resistant TrackPoint ergonomics keyboard',
      'MIL-STD-810H military durability certification across 12 categories',
      'Computer Vision presence sensing with zero-touch lock and unlock',
      '57Wh battery with RapidCharge (80% in 60 mins)'
    ],
    inStock: true,
    stockCount: 15,
    leadTimeDays: 2,
    rating: 4.8,
    reviewCount: 188,
    imageUrl: 'https://images.unsplash.com/photo-1588872657578-7efd1f1555ed?auto=format&fit=crop&w=800&q=80',
    badge: 'Best Seller',
    tags: ['laptop', 'thinkpad', 'lenovo', 'ultrabook', 'windows', 'intel']
  },

  // 6. Steelcase Gesture Ergonomic Office Chair
  {
    id: 'prod-steelcase-gesture',
    sku: 'STC-GST-EL-BLK',
    name: 'Steelcase Gesture Ergonomic Office Chair',
    brand: 'Steelcase',
    category: 'Ergonomics',
    tier: 'Flagship',
    price: 1180.0,
    currency: 'USD',
    shortDescription: 'Designed around modern multi-device postures with 360-degree rotating arms.',
    description: 'Engineered based on global posture studies analyzing smartphones, tablets, and multi-monitor setups. Features the dynamic Core Equalizer back mechanism and soft edge-release seat cushion.',
    specifications: {
      'Mechanism': 'Core Equalizer 3D LiveBack system',
      'Armrests': 'Full 360-degree ball-joint rotation with height, width, and depth adjustment',
      'Seat Depth': 'Passive seat edge flex with 2.75" depth adjustment slider',
      'Weight Capacity': 'Tested and rated up to 400 lbs (181 kg)',
      'Warranty': 'Steelcase 12-Year Multi-Shift Warranty'
    },
    features: [
      'Armrests mimic the human arm with 360-degree articulation',
      'Continuous lumbar support adjusts automatically as you recline',
      'Breathable, high-density foam cushion tested for 12+ hour shifts',
      'Optimized for mobile device holding and relaxed reclined typing'
    ],
    inStock: true,
    stockCount: 14,
    leadTimeDays: 3,
    rating: 4.8,
    reviewCount: 215,
    imageUrl: 'https://images.unsplash.com/photo-1505843490538-5133c6c7d0e1?auto=format&fit=crop&w=800&q=80',
    badge: 'Ergonomic Choice',
    tags: ['chair', 'steelcase', 'ergonomics', 'seating', 'executive']
  },

  // 7. Studio Display 27" 5K
  {
    id: 'prod-apple-studio-display',
    sku: 'APL-STD-DSP-5K',
    name: 'Apple Studio Display 27" 5K Retina (Standard Glass)',
    brand: 'Apple',
    category: 'Displays',
    tier: 'Flagship',
    price: 1599.0,
    currency: 'USD',
    shortDescription: '5K Retina clarity with A13 Bionic chip powering Center Stage and spatial audio.',
    description: 'Features 5120 x 2880 resolution with 14.7 million pixels at 218 PPI. Packed with a 12MP Ultra Wide camera with Center Stage, studio-quality three-microphone array, and six speakers with Spatial Audio.',
    specifications: {
      'Panel': '27-inch (diagonal) 5K Retina display (5120 x 2880)',
      'Brightness': '600 nits brightness, Wide color (P3), True Tone technology',
      'Built-in Processor': 'Apple A13 Bionic chip managing camera, audio & mics',
      'Camera': '12MP Ultra Wide camera with 122° field of view and Center Stage',
      'Ports': '1x Thunderbolt 3 upstream (96W host charging), 3x USB-C downstream (up to 10Gbps)'
    },
    features: [
      'Native macOS integration with hardware brightness control',
      'Six-speaker sound system with force-cancelling woofers and Dolby Atmos',
      'Studio-quality three-mic array with directional beamforming',
      'Single cable setup powers MacBook and drives all peripherals'
    ],
    inStock: true,
    stockCount: 11,
    leadTimeDays: 2,
    rating: 4.7,
    reviewCount: 310,
    imageUrl: 'https://images.unsplash.com/photo-1547394765-185e1e68f34e?auto=format&fit=crop&w=800&q=80',
    badge: 'Best Seller',
    tags: ['display', 'monitor', '5k', 'apple', 'retina', 'mac']
  },

  // 8. Sony WH-1000XM5 ANC Headphones
  {
    id: 'prod-sony-wh1000xm5',
    sku: 'SNY-WHXM5-SLV',
    name: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones',
    brand: 'Sony',
    category: 'Audio',
    tier: 'Mid-Tier',
    price: 399.0,
    currency: 'USD',
    shortDescription: 'World-class active noise cancellation with 8 microphones and LDAC lossless Bluetooth.',
    description: 'Equipped with dual Integrated Processor V1 and HD Noise Cancelling Processor QN1, controlling 8 microphones to silence open-office chatter and background noise for deep focus.',
    specifications: {
      'ANC Processors': 'Integrated Processor V1 + HD Noise Cancelling Processor QN1',
      'Drivers': '30mm carbon fiber composite dome drivers',
      'Battery Life': 'Up to 30 hours with ANC enabled (3 min quick charge yields 3 hours)',
      'Microphones': '8 microphones with AI-based beamforming voice pickup',
      'Multipoint': 'Bluetooth 5.2 simultaneous dual-device connection'
    },
    features: [
      'Speak-to-Chat auto-pauses music when you begin speaking',
      'Auto NC Optimizer dynamically adjusts to air pressure and ambient noise',
      'Soft-fit leatherette headband with zero pressure clamp force',
      'Certified Hi-Res Audio and Hi-Res Audio Wireless'
    ],
    inStock: true,
    stockCount: 42,
    leadTimeDays: 1,
    rating: 4.8,
    reviewCount: 890,
    imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
    badge: 'Best Seller',
    tags: ['audio', 'headphones', 'anc', 'sony', 'wireless', 'focus']
  },

  // 9. CalDigit TS4 Thunderbolt 4 Dock
  {
    id: 'prod-caldigit-ts4',
    sku: 'CDT-TS4-US-ALU',
    name: 'CalDigit TS4 Thunderbolt 4 Docking Station (18-in-1)',
    brand: 'CalDigit',
    category: 'Peripherals',
    tier: 'Flagship',
    price: 399.0,
    currency: 'USD',
    shortDescription: 'The undisputed benchmark workstation dock with 18 ports and 98W Power Delivery.',
    description: 'Provides 18 total ports including 3x Thunderbolt 4 ports, 2.5 Gigabit Ethernet, DisplayPort 1.4, SD 4.0 and microSD UHS-II slots, and 98W host charging for dual 6K or single 8K displays.',
    specifications: {
      'Host Connection': 'Thunderbolt 4 / USB4 (40Gb/s upstream, 98W PD)',
      'Ports': '3x TB4, 5x USB-A 3.2 Gen2, 3x USB-C 3.2 Gen2, DP 1.4, 2.5GbE LAN, 3.5mm combo audio',
      'Display Output': 'Supports dual 6K 60Hz displays or single 8K 60Hz',
      'Power Delivery': '98W continuous full power to host laptop',
      'Construction': 'Solid heat-dissipating anodized aluminum casing'
    },
    features: [
      '18 ports on a single Thunderbolt cable connection',
      'Offline 7.5W front USB charging without needing laptop awake',
      'Fast 2.5GbE Ethernet speeds up NAS transfer speeds',
      'Universal compatibility with macOS, Windows, and Linux'
    ],
    inStock: true,
    stockCount: 30,
    leadTimeDays: 2,
    rating: 4.9,
    reviewCount: 412,
    imageUrl: 'https://images.unsplash.com/photo-1544652478-6653e09f18a2?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['dock', 'caldigit', 'thunderbolt', 'connectivity', 'workstation']
  },

  // 10. Shure SM7B Studio Vocal Microphone
  {
    id: 'prod-shure-sm7b',
    sku: 'SHR-SM7B-DYN',
    name: 'Shure SM7B Cardioid Dynamic Studio Microphone',
    brand: 'Shure',
    category: 'Audio',
    tier: 'Flagship',
    price: 399.0,
    currency: 'USD',
    shortDescription: 'Industry benchmark dynamic broadcast microphone with electromagnetic shielding.',
    description: 'Renowned broadcast dynamic microphone delivering warm, velvety speech for executive presentations, podcasts, client calls, and voice recordings with internal air suspension shock isolation.',
    specifications: {
      'Type': 'Dynamic (moving coil) Cardioid Polar Pattern',
      'Frequency Response': '50 to 20,000 Hz',
      'Shielding': 'Internal electromagnetic humbucking coil against computer monitors',
      'Controls': 'Bass roll-off and mid-range emphasis (presence boost) switches',
      'Connector': 'Three-pin professional audio XLR male'
    },
    features: [
      'Classic cardioid pickup pattern rejects off-axis room reverberation',
      'Internal air suspension shock isolation eliminates mechanical handling noise',
      'Included A7WS detachable windscreen for close-talk plosive protection',
      'Rugged all-metal construction built to last decades'
    ],
    inStock: true,
    stockCount: 22,
    leadTimeDays: 2,
    rating: 4.9,
    reviewCount: 740,
    imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['microphone', 'shure', 'audio', 'podcast', 'broadcast', 'streaming']
  },

  // 11. Logitech MX Master 3S + MX Mechanical Mini Bundle
  {
    id: 'prod-logi-mx-bundle',
    sku: 'LOG-MX3S-MECH-BND',
    name: 'Logitech MX Master 3S Mouse + MX Mechanical Keyboard Bundle',
    brand: 'Logitech',
    category: 'Peripherals',
    tier: 'Mid-Tier',
    price: 249.0,
    currency: 'USD',
    shortDescription: 'Precision 8,000 DPI quiet-click sensor mouse with tactile low-profile mechanical keyboard.',
    description: 'The ultimate professional input combo. The MX Master 3S features an 8K DPI track-on-glass sensor and MagSpeed 1000 lines/sec electromagnetic scroll wheel, paired with low-profile quiet tactile keys.',
    specifications: {
      'Sensor': 'Darkfield high precision sensor (200 to 8000 DPI, tracking on glass)',
      'Key Switches': 'Low-profile Tactile Quiet Mechanical Switches',
      'Connectivity': 'Bluetooth Low Energy & Logi Bolt USB Secure Receiver',
      'Battery': 'Rechargeable Li-Po (Mouse 70 days, Keyboard up to 15 days with backlight)',
      'Multi-Device': 'Pair up to 3 devices with seamless Flow cross-computer copy/paste'
    },
    features: [
      'Quiet Click switches reduce click noise by 90%',
      'Smart illumination auto-adjusts based on ambient light and hand proximity',
      'Logitech Flow enables file transfer between Mac and Windows computers',
      'Customizable gesture button and horizontal thumb wheel'
    ],
    inStock: true,
    stockCount: 50,
    leadTimeDays: 1,
    rating: 4.9,
    reviewCount: 1120,
    imageUrl: 'https://images.unsplash.com/photo-1618384887929-16ec33fab9ef?auto=format&fit=crop&w=800&q=80',
    badge: 'Top Value',
    tags: ['mouse', 'keyboard', 'logitech', 'mx master', 'peripherals', 'bundle']
  },

  // 12. LG 34" UltraWide OLED Curved Monitor
  {
    id: 'prod-lg-34gs95qe',
    sku: 'LG-34GS95QE-OLED',
    name: 'LG UltraGear 34" Curved WQHD OLED Monitor (800R Curve)',
    brand: 'LG',
    category: 'Displays',
    tier: 'Flagship',
    price: 1299.0,
    currency: 'USD',
    shortDescription: 'Immersive 800R curved OLED display with 0.03ms response time and pure infinite contrast.',
    description: 'Combines an ultra-immersive 800R curve with a 3440 x 1440 WQHD OLED panel, 240Hz refresh rate, 98.5% DCI-P3 color fidelity, and VESA DisplayHDR True Black 400 for intense multitasking and creative design.',
    specifications: {
      'Panel': '34-inch Curved OLED (800R curvature, 21:9 Aspect Ratio)',
      'Resolution': '3440 x 1440 WQHD at 240Hz',
      'Response Time': '0.03ms (GtG) with AMD FreeSync Premium Pro & G-Sync Compatible',
      'Contrast Ratio': '1,500,000:1 True Black contrast',
      'Ports': '2x HDMI 2.1, 1x DisplayPort 1.4 with DSC, 2x USB 3.0 downstream hub'
    },
    features: [
      'Dramatic 800R curve wraps naturally around human peripheral vision',
      'Anti-glare low reflection OLED coating minimizes office light bounces',
      'Hardware calibration ready for precise color grading workflows',
      'Picture-by-Picture (PBP) and Picture-in-Picture (PIP) multitasking support'
    ],
    inStock: true,
    stockCount: 10,
    leadTimeDays: 3,
    rating: 4.7,
    reviewCount: 165,
    imageUrl: 'https://images.unsplash.com/photo-1593642632823-8f785ba67e45?auto=format&fit=crop&w=800&q=80',
    badge: 'Best Seller',
    tags: ['display', 'oled', 'lg', 'ultrawide', 'curved', 'monitor']
  },

  // 13. Ubiquiti UniFi Dream Machine Special Edition (UDM-SE)
  {
    id: 'prod-ubnt-udm-se',
    sku: 'UBNT-UDM-SE-10G',
    name: 'Ubiquiti UniFi Dream Machine Special Edition (UDM-SE)',
    brand: 'Ubiquiti',
    category: 'Networking',
    tier: 'Enterprise',
    price: 499.0,
    currency: 'USD',
    shortDescription: 'All-in-one 10G enterprise router, PoE switch, and network security gateway.',
    description: 'Designed for startups and growing offices requiring enterprise-grade firewall throughput, built-in PoE switch, 2.5GbE WAN, 10G SFP+ connectivity, integrated 128GB SSD storage, and centralized UniFi OS.',
    specifications: {
      'Routing Throughput': '3.5 Gbps with full IPS/IDS Deep Packet Inspection enabled',
      'Switching': '8-Port Gigabit Switch with (2) PoE+ and (6) PoE ports (130W total budget)',
      'WAN': '(1) 2.5GbE RJ45 WAN port, (1) 10G SFP+ WAN port with multi-WAN failover',
      'Processor': 'Quad-Core ARM Cortex-A57 at 1.7 GHz, 4GB DDR4 RAM',
      'Storage': 'Integrated 128GB internal SSD + 3.5" HDD bay for video surveillance'
    },
    features: [
      'Next-generation application-aware firewall and intrusion prevention (IPS/IDS)',
      'Dual WAN redundancy with automated failover and load balancing',
      'Zero-subscription UniFi OS centralized cloud management',
      'Integrated PoE powers access points and VoIP phones directly'
    ],
    inStock: true,
    stockCount: 19,
    leadTimeDays: 2,
    rating: 4.9,
    reviewCount: 420,
    imageUrl: 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['networking', 'router', 'ubiquiti', 'unifi', 'firewall', 'security']
  },

  // 14. Dell XPS 15 9530 Workstation Laptop
  {
    id: 'prod-dell-xps-15',
    sku: 'DEL-XPS15-13900H-32G',
    name: 'Dell XPS 15 9530 (i9-13900H, RTX 4070, 32GB)',
    brand: 'Dell',
    category: 'Computing',
    tier: 'Flagship',
    price: 2199.0,
    currency: 'USD',
    shortDescription: 'High-performance mobile powerhouse with 3.5K OLED touchscreen and NVIDIA RTX 4070 graphics.',
    description: 'Precision-crafted from CNC machined aluminum with carbon fiber palm rests. Packs the 14-core Intel Core i9-13900H, 32GB DDR5-4800MHz, 1TB PCIe NVMe SSD, and discrete NVIDIA GeForce RTX 4070 8GB GDDR6.',
    specifications: {
      'Processor': '13th Gen Intel Core i9-13900H (14 Cores, 20 Threads, up to 5.4 GHz Turbo)',
      'Graphics': 'NVIDIA GeForce RTX 4070 8GB GDDR6 (40W TGP)',
      'Memory': '32GB DDR5-4800MHz Dual Channel',
      'Storage': '1TB M.2 PCIe NVMe SSD',
      'Display': '15.6" 3.5K (3456 x 2160) OLED InfinityEdge Touch, 400-nit, 100% DCI-P3',
      'Battery': '86Wh integrated with 130W Type-C AC adapter'
    },
    features: [
      'Four-sided InfinityEdge display with 92.9% screen-to-body ratio',
      'Waves Nx 3D audio quad-speaker design with 8W total output',
      'Dual Thunderbolt 4 ports with Power Delivery and DisplayPort',
      'Full SD card reader slot ideal for multimedia transfers'
    ],
    inStock: true,
    stockCount: 16,
    leadTimeDays: 2,
    rating: 4.7,
    reviewCount: 310,
    imageUrl: 'https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?auto=format&fit=crop&w=800&q=80',
    badge: 'Enterprise Pick',
    tags: ['laptop', 'dell', 'xps', 'workstation', 'windows', 'nvidia', 'rtx']
  }
];
