import * as THREE from "three";
import { COSTS } from "./actions";
import { gameEvents } from "./events";
import { GameState, getStraightLineTiles, GRID_SIZE, isZoneKind, ToolKind } from "./state";
import { getCarInterpolatedTransform, MAX_CARS, TrafficSystem } from "./traffic";

export interface CityRendererOptions {
  container: HTMLElement;
  getState: () => GameState;
  getTraffic?: () => TrafficSystem;
  getTickAlpha?: () => number;
  getTool?: () => ToolKind;
  isToolUnlocked?: (tool: ToolKind) => boolean;
  getSelectedTile?: () => { x: number; y: number } | null;
  isFirstRunScreen?: () => boolean;
  onPaintTiles: (tiles: Array<{ x: number; y: number }>) => void;
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
  onHoverTile?: (tile: { x: number; y: number } | null) => void;
  onSelectTile?: (tile: { x: number; y: number } | null) => void;
}

// Pastel miniature diorama ground & zone colors
const GROUND_CREAM_A = 0xf3ead7;
const GROUND_CREAM_B = 0xede2cb;
const ZONE_PAD_COLORS: Record<"res" | "com" | "ind", number> = {
  res: 0xf4c7b8, // warm terracotta peach pastel
  com: 0xb8e0ea, // soft glass teal blue
  ind: 0xead89b, // muted ochre sand
};

export function gridToWorld(gx: number, gy: number, gridSize: number = GRID_SIZE) {
  const half = gridSize / 2 - 0.5;
  return {
    wx: gx - half,
    wz: gy - half,
  };
}

export function worldToGrid(wx: number, wz: number, gridSize: number = GRID_SIZE) {
  const half = gridSize / 2 - 0.5;
  const gx = Math.round(wx + half);
  const gy = Math.round(wz + half);
  if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) {
    return null;
  }
  return { x: gx, y: gy };
}

function tileSeed(gx: number, gy: number): number {
  let h = (gx * 374761393 + gy * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Creates a bevelled/rounded box geometry with origin at bottom center (y=0..height)
 */
function createBeveledBoxGeometry(
  width: number,
  height: number,
  depth: number,
  radius: number = 0.035,
  bevel: number = 0.018,
): THREE.BufferGeometry {
  const w = Math.max(0.04, width - bevel * 2);
  const d = Math.max(0.04, depth - bevel * 2);
  const r = Math.min(radius, w * 0.4, d * 0.4);

  const shape = new THREE.Shape();
  const hw = w / 2;
  const hd = d / 2;

  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd);
  shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  shape.lineTo(hw, hd - r);
  shape.quadraticCurveTo(hw, hd, hw - r, hd);
  shape.lineTo(-hw + r, hd);
  shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  shape.lineTo(-hw, -hd + r);
  shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);

  const extrudeDepth = Math.max(0.01, height - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: extrudeDepth,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Creates a hollow 3D square tile outline frame with subtle rounded corners
 */
function createHollowTileFrameGeometry(
  outerSize: number = 1.02,
  borderWidth: number = 0.085,
  height: number = 0.045,
): THREE.BufferGeometry {
  const hs = outerSize / 2;
  const ihs = Math.max(0.1, hs - borderWidth);
  const r = 0.05;
  const ir = 0.025;

  const shape = new THREE.Shape();
  shape.moveTo(-hs + r, -hs);
  shape.lineTo(hs - r, -hs);
  shape.quadraticCurveTo(hs, -hs, hs, -hs + r);
  shape.lineTo(hs, hs - r);
  shape.quadraticCurveTo(hs, hs, hs - r, hs);
  shape.lineTo(-hs + r, hs);
  shape.quadraticCurveTo(-hs, hs, -hs, hs - r);
  shape.lineTo(-hs, -hs + r);
  shape.quadraticCurveTo(-hs, -hs, -hs + r, -hs);

  const hole = new THREE.Path();
  hole.moveTo(-ihs + ir, -ihs);
  hole.lineTo(ihs - ir, -ihs);
  hole.quadraticCurveTo(ihs, -ihs, ihs, -ihs + ir);
  hole.lineTo(ihs, ihs - ir);
  hole.quadraticCurveTo(ihs, ihs, ihs - ir, ihs);
  hole.lineTo(-ihs + ir, ihs);
  hole.quadraticCurveTo(-ihs, ihs, -ihs, ihs - ir);
  hole.lineTo(-ihs, -ihs + ir);
  hole.quadraticCurveTo(-ihs, -ihs, -ihs + ir, -ihs);
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.008,
    bevelThickness: 0.008,
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Creates a pitched gable roof prism geometry centered in X/Z with base at y=0
 */
function createPitchedRoofGeometry(
  width: number,
  height: number,
  depth: number,
): THREE.BufferGeometry {
  const hw = width / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(0, height);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 0.02,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.012,
    bevelThickness: 0.012,
  });
  geo.translate(0, 0, -(depth - 0.02) / 2);
  geo.computeVertexNormals();
  return geo;
}

function easeOutBack(t: number, overshoot: number = 1.75): number {
  const clamped = Math.max(0, Math.min(1, t));
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(clamped - 1, 3) + overshoot * Math.pow(clamped - 1, 2);
}

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

interface BuildingVisual {
  key: string;
  gx: number;
  gy: number;
  kind: "res" | "com" | "ind";
  level: number;
  seed: number;
  currentScaleY: number;
  targetScaleY: number;
  spawnedAt: number;
  roofHeight: number;
  rootGroup: THREE.Group;
  bodyGroup: THREE.Group;
  gardenGroup: THREE.Group | null;
  swayTargets: THREE.Object3D[];
  steamPuffs: THREE.Mesh[];
  gardenPlantedAt?: number;
  flagGroup: THREE.Group | null;
}

interface DustParticle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  bornAt: number;
  duration: number;
  initialScale: number;
}

interface FloatingLabel {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  bornAt: number;
  duration: number;
  startY: number;
}

export class CityRenderer {
  private container: HTMLElement;
  private getState: () => GameState;
  private getTraffic?: () => TrafficSystem;
  private getTickAlpha?: () => number;
  private getTool?: () => ToolKind;
  private isToolUnlocked?: (tool: ToolKind) => boolean;
  private getSelectedTile?: () => { x: number; y: number } | null;
  private isFirstRunScreen?: () => boolean;
  private onPaintTiles: (tiles: Array<{ x: number; y: number }>) => void;
  private onStrokeStart?: () => void;
  private onStrokeEnd?: () => void;
  private onHoverTile?: (tile: { x: number; y: number } | null) => void;
  private onSelectTile?: (tile: { x: number; y: number } | null) => void;

  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer | null = null;
  private domElement: HTMLElement;

  // Camera orientation & eased rotation state
  private yawIndex = 0; // 0 => 45deg, 1 => 135deg, 2 => 225deg, 3 => 315deg
  private currentYaw = Math.PI / 4;
  private yawAnimFrom = Math.PI / 4;
  private yawAnimTo = Math.PI / 4;
  private yawAnimStartAt = 0;
  private readonly yawAnimDuration = 400;
  private readonly pitch = Math.atan(1 / Math.sqrt(2)); // ~35.264deg
  private readonly cameraDistance = 48;
  private target = new THREE.Vector3(0, 0, 0);
  private frustumSize = 26;
  private idleBobOffsetY = 0;
  private idleBobYaw = 0;

  private reducedMotion = false;
  private hasDoneInitialSync = false;

  private raycaster = new THREE.Raycaster();
  private pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Lights & sky
  private hemiLight!: THREE.HemisphereLight;
  private dirLight!: THREE.DirectionalLight;
  private fillLight!: THREE.DirectionalLight;
  private skyCanvas!: HTMLCanvasElement;
  private skyCtx!: CanvasRenderingContext2D | null;
  private skyTexture!: THREE.CanvasTexture;
  private sceneFog!: THREE.FogExp2;
  private lastSkyBucket = -1;
  private lastWindowLitTier = -1;
  private currentNightFactor = 0;

  // Drifting cloud shadows over the island
  private cloudShadowTexture: THREE.CanvasTexture | null = null;
  private cloudShadowMesh: THREE.Mesh | null = null;

  // Grid & Buildings
  private tileMeshes: THREE.Mesh[][] = [];
  private roadMaskCache = new Map<number, THREE.CanvasTexture>();
  private zonePadTextures = new Map<"res" | "com" | "ind", THREE.CanvasTexture>();
  private buildingGroup = new THREE.Group();
  private buildingVisuals = new Map<string, BuildingVisual>();
  private highlightGroup = new THREE.Group();
  private hoverOutlineMeshes: THREE.Mesh[] = [];
  private ghostMeshes: THREE.Object3D[] = [];

  // Cars (body + cabin + wheels + night headlights)
  private carBodyMesh: THREE.InstancedMesh;
  private carCabinMesh: THREE.InstancedMesh;
  private carHeadlightMesh: THREE.InstancedMesh;
  private carBeamMesh: THREE.InstancedMesh;
  private carHeadlightMat: THREE.MeshBasicMaterial;
  private carBeamMat: THREE.MeshBasicMaterial;
  private dummyObj = new THREE.Object3D();
  private dummySubObj = new THREE.Object3D();
  private tempColor = new THREE.Color();

  private hoveredTile: { x: number; y: number } | null = null;
  private dragStartTile: { x: number; y: number } | null = null;
  private pointerDownClient: { x: number; y: number } | null = null;
  private isPainting = false;
  private isPanning = false;
  private lastPanClient = { x: 0, y: 0 };
  private activePointers = new Map<number, { x: number; y: number }>();

  private animationFrameId = 0;
  private resizeObserver: ResizeObserver | null = null;

  // Shared Geometries
  private tileGeo = createBeveledBoxGeometry(0.96, 0.14, 0.96, 0.04, 0.015);
  private roadGeo = createBeveledBoxGeometry(1.0, 0.17, 1.0, 0.02, 0.01);
  private hoverFrameGeo = createHollowTileFrameGeometry(1.02, 0.085, 0.045);
  private ghostZoneBoxGeo = createBeveledBoxGeometry(0.68, 0.52, 0.68, 0.03, 0.012);

  // Shared Hover & Ghost Materials
  private validOutlineMat = new THREE.MeshBasicMaterial({
    color: 0x2a9d8f,
    transparent: true,
    opacity: 0.88,
  });
  private invalidOutlineMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.95,
  });
  private selectOutlineMat = new THREE.MeshBasicMaterial({
    color: 0xf4b942,
    transparent: true,
    opacity: 0.92,
  });
  private invalidGhostSlabMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.62,
  });

  // Shared building facade textures & materials
  private facadeDayTextures = new Map<string, THREE.CanvasTexture>();
  private facadeEmissiveCanvases = new Map<string, HTMLCanvasElement>();
  private facadeEmissiveTextures = new Map<string, THREE.CanvasTexture>();
  private facadeMaterials = new Map<string, THREE.MeshLambertMaterial>();

  // Shared Architectural Materials
  private roofTerracottaMatA = new THREE.MeshLambertMaterial({ color: 0xe07a5f });
  private roofTerracottaMatB = new THREE.MeshLambertMaterial({ color: 0xec8f6e });
  private roofTerracottaMatC = new THREE.MeshLambertMaterial({ color: 0xc9644a });
  private trimCreamMat = new THREE.MeshLambertMaterial({ color: 0xf6efe2 });
  private comTrimMat = new THREE.MeshLambertMaterial({ color: 0xe6f2f5 });
  private comAwningMatA = new THREE.MeshLambertMaterial({ color: 0x2a9d8f });
  private comAwningMatB = new THREE.MeshLambertMaterial({ color: 0xe76f51 });
  private indRoofMat = new THREE.MeshLambertMaterial({ color: 0x5c6470 });
  private indChimneyMat = new THREE.MeshLambertMaterial({ color: 0x8d5b4c });
  private indChimneyRimMat = new THREE.MeshLambertMaterial({ color: 0x3d4048 });
  private indSiloMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c5 });
  private steamMat = new THREE.MeshLambertMaterial({
    color: 0xf8f9fa,
    transparent: true,
    opacity: 0.72,
  });

  // Rooftop garden shared geometries & materials
  private gardenDeckGeo = createBeveledBoxGeometry(0.68, 0.055, 0.68, 0.03, 0.01);
  private gardenDeckMat = new THREE.MeshLambertMaterial({ color: 0xc87d55 }); // warm terracotta planter rim
  private gardenLawnGeo = createBeveledBoxGeometry(0.6, 0.045, 0.6, 0.025, 0.008);
  private gardenLawnMat = new THREE.MeshLambertMaterial({ color: 0x52b788 });
  private hedgeLongGeo = createBeveledBoxGeometry(0.56, 0.075, 0.085, 0.02, 0.008);
  private hedgeShortGeo = createBeveledBoxGeometry(0.085, 0.075, 0.42, 0.02, 0.008);
  private hedgeMat = new THREE.MeshLambertMaterial({ color: 0x2d6a4f });
  private trunkGeo = new THREE.CylinderGeometry(0.022, 0.032, 0.13, 6);
  private trunkMat = new THREE.MeshLambertMaterial({ color: 0x7f5539 });
  private sphereCanopyGeoA = new THREE.SphereGeometry(0.115, 10, 8);
  private sphereCanopyGeoB = new THREE.SphereGeometry(0.09, 10, 8);
  private canopyMatA = new THREE.MeshLambertMaterial({ color: 0x40916c });
  private canopyMatB = new THREE.MeshLambertMaterial({ color: 0x52b788 });
  private canopyMatC = new THREE.MeshLambertMaterial({ color: 0x74c69d });
  private flowerGeo = new THREE.SphereGeometry(0.032, 7, 6);
  private flowerMats = [
    new THREE.MeshLambertMaterial({ color: 0xffbe0b }), // marigold yellow
    new THREE.MeshLambertMaterial({ color: 0xff6b8b }), // blossom coral pink
    new THREE.MeshLambertMaterial({ color: 0xb583ff }), // lavender violet
  ];

  // No-road warning badge
  private flagPoleGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6);
  private flagBadgeGeo = createBeveledBoxGeometry(0.18, 0.14, 0.05, 0.02, 0.008);
  private flagMat = new THREE.MeshBasicMaterial({ color: 0xe63946 });

  // FX: Dust puff particles & floating '+$' labels
  private fxGroup = new THREE.Group();
  private dustParticles: DustParticle[] = [];
  private floatingLabels: FloatingLabel[] = [];
  private dustGeo = new THREE.SphereGeometry(0.075, 7, 6);

  constructor(options: CityRendererOptions) {
    this.container = options.container;
    this.getState = options.getState;
    this.getTraffic = options.getTraffic;
    this.getTickAlpha = options.getTickAlpha;
    this.getTool = options.getTool;
    this.isToolUnlocked = options.isToolUnlocked;
    this.getSelectedTile = options.getSelectedTile;
    this.isFirstRunScreen = options.isFirstRunScreen;
    this.onPaintTiles = options.onPaintTiles;
    this.onStrokeStart = options.onStrokeStart;
    this.onStrokeEnd = options.onStrokeEnd;
    this.onHoverTile = options.onHoverTile;
    this.onSelectTile = options.onSelectTile;

    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMotion = mq.matches;
      const onMotionChange = (e: MediaQueryListEvent) => {
        this.reducedMotion = e.matches;
      };
      mq.addEventListener?.("change", onMotionChange);
      this.cleanupFns.push(() => mq.removeEventListener?.("change", onMotionChange));
    }

    this.scene = new THREE.Scene();
    this.sceneFog = new THREE.FogExp2(0xf5dec9, 0.0065);
    this.scene.fog = this.sceneFog;

    this.initSkyGradient();
    this.initFacadeMaterials();
    this.initZonePadTextures();

    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const aspect = width / height;

    this.camera = new THREE.OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      -200,
      200,
    );
    this.camera.zoom = 1;
    this.updateCameraTransform();

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(width, height);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.04;
      this.domElement = this.renderer.domElement;
    } catch {
      const fallback = document.createElement("canvas");
      fallback.width = width;
      fallback.height = height;
      this.domElement = fallback;
    }

    this.domElement.className = "block h-full w-full select-none touch-none";
    this.container.innerHTML = "";
    this.container.appendChild(this.domElement);

    // Cars: Body + Cabin + Night Headlights + Light Beams
    const carBodyGeo = createBeveledBoxGeometry(0.32, 0.095, 0.18, 0.03, 0.012);
    const carBodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.carBodyMesh = new THREE.InstancedMesh(carBodyGeo, carBodyMat, MAX_CARS);
    this.carBodyMesh.castShadow = true;
    this.carBodyMesh.receiveShadow = true;
    this.carBodyMesh.count = 0;
    this.carBodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const carCabinGeo = createBeveledBoxGeometry(0.17, 0.075, 0.145, 0.025, 0.01);
    const carCabinMat = new THREE.MeshLambertMaterial({ color: 0x3b4254 });
    this.carCabinMesh = new THREE.InstancedMesh(carCabinGeo, carCabinMat, MAX_CARS);
    this.carCabinMesh.castShadow = true;
    this.carCabinMesh.count = 0;
    this.carCabinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const headlightGeo = new THREE.BoxGeometry(0.03, 0.035, 0.13);
    this.carHeadlightMat = new THREE.MeshBasicMaterial({
      color: 0xfff3b0,
      transparent: true,
      opacity: 0.25,
    });
    this.carHeadlightMesh = new THREE.InstancedMesh(
      headlightGeo,
      this.carHeadlightMat,
      MAX_CARS,
    );
    this.carHeadlightMesh.count = 0;
    this.carHeadlightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const beamGeo = new THREE.ConeGeometry(0.11, 0.28, 8, 1, true);
    beamGeo.rotateZ(Math.PI / 2);
    beamGeo.translate(0.15, 0, 0);
    this.carBeamMat = new THREE.MeshBasicMaterial({
      color: 0xffe89e,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.carBeamMesh = new THREE.InstancedMesh(beamGeo, this.carBeamMat, MAX_CARS);
    this.carBeamMesh.count = 0;
    this.carBeamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.setupLights();
    this.setupGrid();
    this.setupCloudShadows();
    this.scene.add(this.buildingGroup);
    this.scene.add(this.carBodyMesh);
    this.scene.add(this.carCabinMesh);
    this.scene.add(this.carHeadlightMesh);
    this.scene.add(this.carBeamMesh);
    this.scene.add(this.highlightGroup);
    this.scene.add(this.fxGroup);

    this.bindEvents();
    this.bindGameFeedbackEvents();
    this.syncFromState();
    this.hasDoneInitialSync = true;
    this.updateDayNightLighting(8);
    this.startLoop();
  }

  private bindGameFeedbackEvents() {
    const unsub = gameEvents.on("*", (ev) => {
      if (ev.type === "placed" && typeof ev.x === "number" && typeof ev.y === "number") {
        const color =
          ev.kind === "bulldoze"
            ? 0xe07a5f
            : ev.kind === "road"
              ? 0xd6ccc2
              : 0xf4e8c1;
        this.spawnDustPuffs(ev.x, ev.y, color, 6);
      } else if (
        (ev.type === "built" || ev.type === "grown") &&
        typeof ev.x === "number" &&
        typeof ev.y === "number"
      ) {
        this.spawnDustPuffs(ev.x, ev.y, 0xf6efe2, 9);
      } else if (
        ev.type === "garden planted" &&
        typeof ev.x === "number" &&
        typeof ev.y === "number"
      ) {
        this.spawnDustPuffs(ev.x, ev.y, 0x74c69d, 10);
        this.spawnFloatingText(ev.x, ev.y, "🌿 +Garden", "#1f6b4a", 1.3);
      } else if (ev.type === "income" && typeof ev.amount === "number" && ev.amount > 0) {
        this.spawnIncomeFloaters(ev.amount);
      } else if (ev.type === "milestone" && typeof ev.amount === "number" && ev.amount > 0) {
        this.spawnFloatingText(16, 16, `🏆 +$${ev.amount}`, "#b87a08", 2.0);
        this.spawnMilestoneSparkleBurst(16, 16);
      } else if (ev.type === "green_city" && typeof ev.amount === "number" && ev.amount > 0) {
        this.spawnFloatingText(16, 16, `🌱 +$${ev.amount} Eco`, "#17695f", 1.8);
      }
    });
    this.cleanupFns.push(unsub);
  }

  private spawnMilestoneSparkleBurst(gx: number, gy: number) {
    if (this.reducedMotion) return;
    const palette = [0xf4b942, 0xe07a5f, 0x2a9d8f, 0x52b788, 0xff6b8b];
    for (let i = 0; i < palette.length; i++) {
      this.spawnDustPuffs(gx + (i % 3) - 1, gy + ((i + 1) % 3) - 1, palette[i], 5);
    }
  }

  public spawnDustPuffs(
    gx: number,
    gy: number,
    colorHex: number = 0xf6efe2,
    count: number = 7,
  ) {
    if (this.reducedMotion) return;
    const state = this.getState();
    const { wx, wz } = gridToWorld(gx, gy, state.gridSize);
    const now = performance.now();

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (i % 2) * 0.25;
      const speed = 0.55 + (i % 3) * 0.2;
      const mat = new THREE.MeshLambertMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.85,
      });
      const mesh = new THREE.Mesh(this.dustGeo, mat);
      const r0 = 0.16;
      mesh.position.set(
        wx + Math.cos(angle) * r0,
        0.12 + (i % 2) * 0.04,
        wz + Math.sin(angle) * r0,
      );
      const initialScale = 0.75 + (i % 3) * 0.22;
      mesh.scale.set(initialScale, initialScale, initialScale);
      this.fxGroup.add(mesh);

      this.dustParticles.push({
        mesh,
        vx: Math.cos(angle) * speed,
        vy: 0.5 + (i % 3) * 0.25,
        vz: Math.sin(angle) * speed,
        bornAt: now,
        duration: 520,
        initialScale,
      });
    }
  }

  private spawnIncomeFloaters(totalIncome: number) {
    const buildings = Array.from(this.buildingVisuals.values());
    if (buildings.length === 0) {
      this.spawnFloatingText(16, 16, `+$${totalIncome}`, "#1f6b4a", 1.2);
      return;
    }

    const step = Math.max(1, Math.floor(buildings.length / 3));
    const picked = [
      buildings[0],
      buildings[Math.min(buildings.length - 1, step)],
      buildings[Math.min(buildings.length - 1, step * 2)],
    ];
    const seen = new Set<string>();
    picked.forEach((b, idx) => {
      if (!b || seen.has(b.key)) return;
      seen.add(b.key);
      const label = idx === 0 ? `+$${totalIncome}` : `+$${b.level * 6}`;
      this.spawnFloatingText(b.gx, b.gy, label, "#1f6b4a", b.roofHeight + 0.45);
    });
  }

  public spawnFloatingText(
    gx: number,
    gy: number,
    text: string,
    accentHex: string = "#1f6b4a",
    baseY: number = 1.2,
  ) {
    const state = this.getState();
    const { wx, wz } = gridToWorld(gx, gy, state.gridSize);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 256, 96);
      ctx.fillStyle = "rgba(252, 248, 240, 0.96)";
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.roundRect(18, 16, 220, 64, 32);
      ctx.fill();
      ctx.stroke();

      ctx.font = "900 34px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = accentHex;
      ctx.fillText(text, 128, 49);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(wx, baseY, wz);
    sprite.scale.set(1.55, 0.58, 1);
    this.fxGroup.add(sprite);

    this.floatingLabels.push({
      sprite,
      material,
      texture,
      bornAt: performance.now(),
      duration: 1450,
      startY: baseY,
    });
  }

  private initSkyGradient() {
    this.skyCanvas = document.createElement("canvas");
    this.skyCanvas.width = 64;
    this.skyCanvas.height = 256;
    this.skyCtx = this.skyCanvas.getContext("2d");
    this.skyTexture = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTexture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.skyTexture;
  }

  private updateSkyGradientCanvas(topHex: string, midHex: string, bottomHex: string) {
    if (!this.skyCtx) return;
    const grad = this.skyCtx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, topHex);
    grad.addColorStop(0.55, midHex);
    grad.addColorStop(1, bottomHex);
    this.skyCtx.fillStyle = grad;
    this.skyCtx.fillRect(0, 0, 64, 256);
    this.skyTexture.needsUpdate = true;
  }

  /**
   * Creates a soft, tiling cloud-shadow layer that drifts gently over the miniature island.
   */
  private setupCloudShadows() {
    const state = this.getState();
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    if (ctx) {
      ctx.clearRect(0, 0, 512, 512);
      const puffs = [
        { x: 110, y: 115, r: 52 },
        { x: 148, y: 125, r: 40 },
        { x: 370, y: 160, r: 48 },
        { x: 402, y: 172, r: 36 },
        { x: 235, y: 360, r: 56 },
        { x: 278, y: 372, r: 42 },
      ];

      for (const p of puffs) {
        for (const ox of [-512, 0, 512]) {
          for (const oy of [-512, 0, 512]) {
            const cx = p.x + ox;
            const cy = p.y + oy;
            const grad = ctx.createRadialGradient(cx, cy, p.r * 0.1, cx, cy, p.r);
            grad.addColorStop(0, "rgba(44, 48, 58, 0.32)");
            grad.addColorStop(0.55, "rgba(44, 48, 58, 0.14)");
            grad.addColorStop(1, "rgba(44, 48, 58, 0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, p.r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    const cloudTex = new THREE.CanvasTexture(canvas);
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    cloudTex.wrapS = THREE.RepeatWrapping;
    cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(1.15, 1.15);
    this.cloudShadowTexture = cloudTex;

    const planeGeo = new THREE.PlaneGeometry(state.gridSize - 0.4, state.gridSize - 0.4);
    planeGeo.rotateX(-Math.PI / 2);

    const cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });

    const cloudMesh = new THREE.Mesh(planeGeo, cloudMat);
    cloudMesh.position.set(0, 0.036, 0);
    this.cloudShadowMesh = cloudMesh;
    this.scene.add(cloudMesh);
  }

  private initZonePadTextures() {
    const configs: Array<{
      kind: "res" | "com" | "ind";
      bg: string;
      border: string;
      stripe: string;
    }> = [
      { kind: "res", bg: "#f6d5c9", border: "#e07a5f", stripe: "#efc2b3" },
      { kind: "com", bg: "#cbe8f0", border: "#38a3a5", stripe: "#b6dce8" },
      { kind: "ind", bg: "#f2e2b3", border: "#c99e4c", stripe: "#e6d29a" },
    ];

    for (const cfg of configs) {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = cfg.bg;
        ctx.fillRect(0, 0, 128, 128);

        ctx.strokeStyle = cfg.stripe;
        ctx.lineWidth = 4;
        for (let i = -128; i < 256; i += 24) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i + 128, 128);
          ctx.stroke();
        }

        ctx.strokeStyle = cfg.border;
        ctx.lineWidth = 6;
        ctx.setLineDash([14, 8]);
        ctx.strokeRect(8, 8, 112, 112);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.zonePadTextures.set(cfg.kind, tex);
    }
  }

  private initFacadeMaterials() {
    const definitions: Array<{
      id: string;
      wallColor: string;
      accentColor: string;
      frameColor: string;
      glassDay: string;
      cols: number;
      rows: number;
      style: "res" | "com" | "ind";
    }> = [
      {
        id: "res_0",
        wallColor: "#f8efe4",
        accentColor: "#ead7c3",
        frameColor: "#d97f64",
        glassDay: "#4a667a",
        cols: 3,
        rows: 4,
        style: "res",
      },
      {
        id: "res_1",
        wallColor: "#f5e4d7",
        accentColor: "#e6ccb8",
        frameColor: "#c86b51",
        glassDay: "#526d82",
        cols: 3,
        rows: 4,
        style: "res",
      },
      {
        id: "com_0",
        wallColor: "#d8eef2",
        accentColor: "#38a3a5",
        frameColor: "#f4f1de",
        glassDay: "#2b6f82",
        cols: 4,
        rows: 5,
        style: "com",
      },
      {
        id: "com_1",
        wallColor: "#d6e8f5",
        accentColor: "#4ea8de",
        frameColor: "#f8f9fa",
        glassDay: "#275dad",
        cols: 4,
        rows: 5,
        style: "com",
      },
      {
        id: "ind_0",
        wallColor: "#dfd3a9",
        accentColor: "#b8aa82",
        frameColor: "#5c626b",
        glassDay: "#48525c",
        cols: 3,
        rows: 2,
        style: "ind",
      },
      {
        id: "ind_1",
        wallColor: "#c9cbc4",
        accentColor: "#a8aba2",
        frameColor: "#52575d",
        glassDay: "#3d4650",
        cols: 3,
        rows: 2,
        style: "ind",
      },
    ];

    for (const def of definitions) {
      const dayCanvas = document.createElement("canvas");
      dayCanvas.width = 128;
      dayCanvas.height = 192;
      const ctx = dayCanvas.getContext("2d");

      if (ctx) {
        ctx.fillStyle = def.wallColor;
        ctx.fillRect(0, 0, 128, 192);

        ctx.fillStyle = def.accentColor;
        for (let r = 0; r <= def.rows; r++) {
          const y = Math.round((r / def.rows) * 192);
          ctx.fillRect(0, y - 2, 128, 4);
        }

        const padX = def.style === "com" ? 8 : 14;
        const padY = 12;
        const cellW = (128 - padX * 2) / def.cols;
        const cellH = (192 - padY * 2) / def.rows;

        for (let r = 0; r < def.rows; r++) {
          for (let c = 0; c < def.cols; c++) {
            const wx = padX + c * cellW + 4;
            const wy = padY + r * cellH + 5;
            const ww = cellW - 8;
            const wh = cellH - 10;

            ctx.fillStyle = def.frameColor;
            ctx.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);

            ctx.fillStyle = def.glassDay;
            ctx.fillRect(wx, wy, ww, wh);

            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.fillRect(wx + 2, wy + 2, ww * 0.38, wh - 4);
          }
        }
      }

      const dayTex = new THREE.CanvasTexture(dayCanvas);
      dayTex.colorSpace = THREE.SRGBColorSpace;
      dayTex.wrapS = THREE.RepeatWrapping;
      dayTex.wrapT = THREE.RepeatWrapping;
      this.facadeDayTextures.set(def.id, dayTex);

      const emCanvas = document.createElement("canvas");
      emCanvas.width = 128;
      emCanvas.height = 192;
      this.facadeEmissiveCanvases.set(def.id, emCanvas);

      const emTex = new THREE.CanvasTexture(emCanvas);
      emTex.colorSpace = THREE.SRGBColorSpace;
      this.facadeEmissiveTextures.set(def.id, emTex);

      const mat = new THREE.MeshLambertMaterial({
        map: dayTex,
        emissive: new THREE.Color(0xffdfa0),
        emissiveMap: emTex,
        emissiveIntensity: 0.05,
      });
      this.facadeMaterials.set(def.id, mat);
    }

    this.updateWindowEmissiveMaps(0);
  }

  private updateWindowEmissiveMaps(litTier: number) {
    if (litTier === this.lastWindowLitTier) return;
    this.lastWindowLitTier = litTier;

    const litRatio = litTier / 8;
    const warmColors = ["#ffe599", "#ffd166", "#fff1c1", "#ffbe76"];

    for (const [id, canvas] of this.facadeEmissiveCanvases.entries()) {
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;

      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 128, 192);

      if (litTier <= 0) {
        const tex = this.facadeEmissiveTextures.get(id);
        if (tex) tex.needsUpdate = true;
        continue;
      }

      const isCom = id.startsWith("com");
      const isInd = id.startsWith("ind");
      const cols = isCom ? 4 : 3;
      const rows = isCom ? 5 : isInd ? 2 : 4;
      const padX = isCom ? 8 : 14;
      const padY = 12;
      const cellW = (128 - padX * 2) / cols;
      const cellH = (192 - padY * 2) / rows;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const paneHash = ((r * 13 + c * 29 + id.charCodeAt(4) * 7) % 17) / 17;
          if (paneHash <= litRatio * 0.88 + 0.08) {
            const wx = padX + c * cellW + 4;
            const wy = padY + r * cellH + 5;
            const ww = cellW - 8;
            const wh = cellH - 10;

            ctx.fillStyle = warmColors[(r + c) % warmColors.length];
            ctx.fillRect(wx, wy, ww, wh);
          }
        }
      }

      const tex = this.facadeEmissiveTextures.get(id);
      if (tex) tex.needsUpdate = true;
    }
  }

  private getRoadTextureForMask(mask: number): THREE.CanvasTexture {
    const cached = this.roadMaskCache.get(mask);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");

    if (ctx) {
      const hasN = (mask & 1) !== 0;
      const hasE = (mask & 2) !== 0;
      const hasS = (mask & 4) !== 0;
      const hasW = (mask & 8) !== 0;
      const degree = (hasN ? 1 : 0) + (hasE ? 1 : 0) + (hasS ? 1 : 0) + (hasW ? 1 : 0);

      ctx.fillStyle = "#dfd5c2";
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = "#cfc3ac";
      ctx.lineWidth = 2;
      for (let i = 32; i < 256; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 256);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(256, i);
        ctx.stroke();
      }

      const roadMin = 44;
      const roadMax = 212;
      const roadWidth = roadMax - roadMin;

      ctx.fillStyle = "#c4b69c";
      const curbPad = 5;
      ctx.fillRect(
        roadMin - curbPad,
        roadMin - curbPad,
        roadWidth + curbPad * 2,
        roadWidth + curbPad * 2,
      );
      if (hasN) ctx.fillRect(roadMin - curbPad, 0, roadWidth + curbPad * 2, roadMin);
      if (hasS) ctx.fillRect(roadMin - curbPad, roadMax, roadWidth + curbPad * 2, 256 - roadMax);
      if (hasW) ctx.fillRect(0, roadMin - curbPad, roadMin, roadWidth + curbPad * 2);
      if (hasE) ctx.fillRect(roadMax, roadMin - curbPad, 256 - roadMax, roadWidth + curbPad * 2);

      ctx.fillStyle = "#4a4f5c";
      ctx.beginPath();
      ctx.roundRect(roadMin, roadMin, roadWidth, roadWidth, 18);
      ctx.fill();

      if (hasN) ctx.fillRect(roadMin, 0, roadWidth, roadMin + 18);
      if (hasS) ctx.fillRect(roadMin, roadMax - 18, roadWidth, 256 - roadMax + 18);
      if (hasW) ctx.fillRect(0, roadMin, roadMin + 18, roadWidth);
      if (hasE) ctx.fillRect(roadMax - 18, roadMin, 256 - roadMax + 18, roadWidth);

      ctx.strokeStyle = "#f8fafc";
      ctx.fillStyle = "#f8fafc";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";

      if (hasN && hasS && !hasE && !hasW) {
        ctx.setLineDash([22, 18]);
        ctx.beginPath();
        ctx.moveTo(128, 0);
        ctx.lineTo(128, 256);
        ctx.stroke();
      } else if (hasE && hasW && !hasN && !hasS) {
        ctx.setLineDash([22, 18]);
        ctx.beginPath();
        ctx.moveTo(0, 128);
        ctx.lineTo(256, 128);
        ctx.stroke();
      } else if (degree === 2 && !(hasN && hasS) && !(hasE && hasW)) {
        ctx.setLineDash([18, 16]);
        ctx.beginPath();
        if (hasN && hasE) {
          ctx.arc(256, 0, 128, Math.PI * 0.5, Math.PI);
        } else if (hasE && hasS) {
          ctx.arc(256, 256, 128, Math.PI, Math.PI * 1.5);
        } else if (hasS && hasW) {
          ctx.arc(0, 256, 128, Math.PI * 1.5, Math.PI * 2);
        } else if (hasW && hasN) {
          ctx.arc(0, 0, 128, 0, Math.PI * 0.5);
        }
        ctx.stroke();
      } else if (degree >= 3) {
        ctx.setLineDash([16, 14]);
        if (hasN) {
          ctx.beginPath();
          ctx.moveTo(128, 0);
          ctx.lineTo(128, roadMin - 6);
          ctx.stroke();
        }
        if (hasS) {
          ctx.beginPath();
          ctx.moveTo(128, 256);
          ctx.lineTo(128, roadMax + 6);
          ctx.stroke();
        }
        if (hasW) {
          ctx.beginPath();
          ctx.moveTo(0, 128);
          ctx.lineTo(roadMin - 6, 128);
          ctx.stroke();
        }
        if (hasE) {
          ctx.beginPath();
          ctx.moveTo(256, 128);
          ctx.lineTo(roadMax + 6, 128);
          ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(248, 250, 252, 0.85)";
        const drawZebraHorizontal = (yPos: number) => {
          for (let x = roadMin + 14; x <= roadMax - 22; x += 22) {
            ctx.fillRect(x, yPos, 10, 20);
          }
        };
        const drawZebraVertical = (xPos: number) => {
          for (let y = roadMin + 14; y <= roadMax - 22; y += 22) {
            ctx.fillRect(xPos, y, 20, 10);
          }
        };

        if (hasN) drawZebraHorizontal(roadMin - 2);
        if (hasS) drawZebraHorizontal(roadMax - 18);
        if (hasW) drawZebraVertical(roadMin - 2);
        if (hasE) drawZebraVertical(roadMax - 18);
      } else {
        ctx.setLineDash([18, 14]);
        if (hasN) {
          ctx.beginPath();
          ctx.moveTo(128, 0);
          ctx.lineTo(128, 128);
          ctx.stroke();
        } else if (hasS) {
          ctx.beginPath();
          ctx.moveTo(128, 256);
          ctx.lineTo(128, 128);
          ctx.stroke();
        } else if (hasW) {
          ctx.beginPath();
          ctx.moveTo(0, 128);
          ctx.lineTo(128, 128);
          ctx.stroke();
        } else if (hasE) {
          ctx.beginPath();
          ctx.moveTo(256, 128);
          ctx.lineTo(128, 128);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(128, 128, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.roadMaskCache.set(mask, tex);
    return tex;
  }

  private setupLights() {
    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0xf3ead7, 0.85);
    this.hemiLight.position.set(0, 40, 0);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xfff5e4, 1.15);
    this.dirLight.position.set(22, 36, 18);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.dirLight.shadow.camera.near = 5;
    this.dirLight.shadow.camera.far = 95;
    const d = 23;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.0005;
    this.scene.add(this.dirLight);

    this.fillLight = new THREE.DirectionalLight(0x93c5fd, 0.35);
    this.fillLight.position.set(-20, 18, -16);
    this.scene.add(this.fillLight);
  }

  private updateDayNightLighting(hour: number) {
    let nightFactor = 0;
    let sunsetFactor = 0;
    if (hour >= 17 && hour < 20.5) {
      nightFactor = (hour - 17) / 3.5;
      sunsetFactor = Math.sin(((hour - 17) / 3.5) * Math.PI);
    } else if (hour >= 20.5 || hour < 4.5) {
      nightFactor = 1;
      sunsetFactor = 0;
    } else if (hour >= 4.5 && hour < 7.5) {
      nightFactor = 1 - (hour - 4.5) / 3.0;
      sunsetFactor = Math.sin(((hour - 4.5) / 3.0) * Math.PI) * 0.8;
    }
    this.currentNightFactor = nightFactor;

    const sunAngle = ((hour - 6) / 24) * Math.PI * 2;
    const lightX = Math.cos(sunAngle) * 24;
    const lightY = Math.max(14, Math.abs(Math.sin(sunAngle)) * 34 + 12);
    const lightZ = 16 + Math.sin(sunAngle * 0.5) * 8;
    this.dirLight.position.set(lightX, lightY, lightZ);

    const dayDir = new THREE.Color(0xfff4df);
    const sunsetDir = new THREE.Color(0xff9e6d);
    const nightDir = new THREE.Color(0x6c8cd5);

    this.dirLight.color
      .copy(dayDir)
      .lerp(sunsetDir, sunsetFactor)
      .lerp(nightDir, nightFactor * 0.85);
    this.dirLight.intensity = 1.15 - nightFactor * 0.62 - sunsetFactor * 0.15;

    const daySky = new THREE.Color(0xdbeeff);
    const sunsetSky = new THREE.Color(0xf9b49b);
    const nightSky = new THREE.Color(0x2b3a67);

    const dayGround = new THREE.Color(0xf3ead7);
    const nightGround = new THREE.Color(0x3a3347);

    this.hemiLight.color.copy(daySky).lerp(sunsetSky, sunsetFactor).lerp(nightSky, nightFactor);
    this.hemiLight.groundColor.copy(dayGround).lerp(nightGround, nightFactor * 0.8);
    this.hemiLight.intensity = 0.85 - nightFactor * 0.35;

    const skyBucket = Math.round(hour * 2);
    if (skyBucket !== this.lastSkyBucket) {
      this.lastSkyBucket = skyBucket;
      const topC = new THREE.Color(0xbce0f7)
        .lerp(new THREE.Color(0x8874a3), sunsetFactor)
        .lerp(new THREE.Color(0x182039), nightFactor);
      const midC = new THREE.Color(0xe5f0f8)
        .lerp(new THREE.Color(0xf4a58a), sunsetFactor)
        .lerp(new THREE.Color(0x253154), nightFactor);
      const botC = new THREE.Color(0xf9dcc4)
        .lerp(new THREE.Color(0xf7b286), sunsetFactor)
        .lerp(new THREE.Color(0x363b5c), nightFactor);

      this.updateSkyGradientCanvas(
        `#${topC.getHexString()}`,
        `#${midC.getHexString()}`,
        `#${botC.getHexString()}`,
      );
      this.sceneFog.color.copy(botC);
    }

    const litTier = Math.round(Math.max(sunsetFactor * 0.7, nightFactor) * 8);
    this.updateWindowEmissiveMaps(litTier);

    const emissiveStrength = 0.04 + Math.max(sunsetFactor * 0.55, nightFactor) * 0.92;
    for (const mat of this.facadeMaterials.values()) {
      mat.emissiveIntensity = emissiveStrength;
    }

    const headlightActive = Math.max(0, (nightFactor - 0.15) / 0.85);
    this.carHeadlightMat.opacity = 0.2 + headlightActive * 0.8;
    this.carBeamMat.opacity = headlightActive * 0.38;

    if (this.cloudShadowMesh) {
      const cloudMat = this.cloudShadowMesh.material as THREE.MeshBasicMaterial;
      cloudMat.opacity = 0.14 * (1 - nightFactor * 0.85);
    }
  }

  private setupGrid() {
    const state = this.getState();
    const islandGroup = new THREE.Group();

    const topRimGeo = createBeveledBoxGeometry(
      state.gridSize + 1.2,
      0.38,
      state.gridSize + 1.2,
      0.45,
      0.08,
    );
    const topRimMat = new THREE.MeshLambertMaterial({ color: 0xe9dec7 });
    const topRim = new THREE.Mesh(topRimGeo, topRimMat);
    topRim.position.set(0, -0.4, 0);
    topRim.receiveShadow = true;
    islandGroup.add(topRim);

    const cliffMidGeo = createBeveledBoxGeometry(
      state.gridSize + 0.4,
      0.65,
      state.gridSize + 0.4,
      0.6,
      0.12,
    );
    const cliffMidMat = new THREE.MeshLambertMaterial({ color: 0xd4bc9b });
    const cliffMid = new THREE.Mesh(cliffMidGeo, cliffMidMat);
    cliffMid.position.set(0, -0.96, 0);
    islandGroup.add(cliffMid);

    const cliffLowerGeo = createBeveledBoxGeometry(
      state.gridSize - 1.6,
      0.75,
      state.gridSize - 1.6,
      0.9,
      0.16,
    );
    const cliffLowerMat = new THREE.MeshLambertMaterial({ color: 0xb89e7d });
    const cliffLower = new THREE.Mesh(cliffLowerGeo, cliffLowerMat);
    cliffLower.position.set(0, -1.58, 0);
    islandGroup.add(cliffLower);

    this.scene.add(islandGroup);

    const tileGroup = new THREE.Group();
    this.tileMeshes = [];

    for (let y = 0; y < state.gridSize; y++) {
      const row: THREE.Mesh[] = [];
      for (let x = 0; x < state.gridSize; x++) {
        const { wx, wz } = gridToWorld(x, y, state.gridSize);
        const baseColor = (x + y) % 2 === 0 ? GROUND_CREAM_A : GROUND_CREAM_B;
        const mat = new THREE.MeshLambertMaterial({ color: baseColor });
        const mesh = new THREE.Mesh(this.tileGeo, mat);
        mesh.position.set(wx, -0.1, wz);
        mesh.receiveShadow = true;
        mesh.userData = { gx: x, gy: y };
        tileGroup.add(mesh);
        row.push(mesh);
      }
      this.tileMeshes.push(row);
    }

    this.scene.add(tileGroup);
  }

  private createBuildingArchitecture(
    kind: "res" | "com" | "ind",
    level: number,
    seed: number,
  ): {
    bodyGroup: THREE.Group;
    roofHeight: number;
    steamPuffs: THREE.Mesh[];
  } {
    const group = new THREE.Group();
    const steamPuffs: THREE.Mesh[] = [];
    const variant = seed % 2;
    const rotSteps = (seed >>> 3) % 4;
    group.rotation.y = rotSteps * (Math.PI / 2);

    const facadeMat =
      this.facadeMaterials.get(`${kind}_${variant}`) ??
      this.facadeMaterials.get(`${kind}_0`)!;

    const roofMats = [this.roofTerracottaMatA, this.roofTerracottaMatB, this.roofTerracottaMatC];
    const roofMat = roofMats[(seed >>> 5) % roofMats.length];

    let roofHeight = 0.8;

    if (kind === "res") {
      if (level === 1) {
        const bodyH = 0.56;
        const bodyGeo = createBeveledBoxGeometry(0.68, bodyH, 0.62, 0.03, 0.015);
        const body = new THREE.Mesh(bodyGeo, facadeMat);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        const porchGeo = createBeveledBoxGeometry(0.28, 0.24, 0.14, 0.02, 0.01);
        const porch = new THREE.Mesh(porchGeo, this.trimCreamMat);
        porch.position.set(0.1, 0, 0.32);
        porch.castShadow = true;
        group.add(porch);

        const roofH = 0.28;
        const pitchedGeo = createPitchedRoofGeometry(0.74, roofH, 0.68);
        const roof = new THREE.Mesh(pitchedGeo, roofMat);
        roof.position.set(0, bodyH - 0.01, 0);
        roof.castShadow = true;
        roof.receiveShadow = true;
        group.add(roof);

        const chimGeo = createBeveledBoxGeometry(0.1, 0.26, 0.1, 0.01, 0.008);
        const chim = new THREE.Mesh(chimGeo, roofMat);
        chim.position.set(-0.18, bodyH + 0.02, -0.14);
        chim.castShadow = true;
        group.add(chim);

        roofHeight = bodyH + roofH * 0.72;
      } else if (level === 2) {
        const baseH = 1.15;
        const bodyGeo = createBeveledBoxGeometry(0.74, baseH, 0.72, 0.03, 0.015);
        const body = new THREE.Mesh(bodyGeo, facadeMat);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        const beltGeo = createBeveledBoxGeometry(0.78, 0.06, 0.76, 0.02, 0.01);
        const belt = new THREE.Mesh(beltGeo, this.trimCreamMat);
        belt.position.set(0, baseH * 0.52, 0);
        group.add(belt);

        const capH = 0.18;
        const capGeo = createBeveledBoxGeometry(0.7, capH, 0.68, 0.03, 0.015);
        const cap = new THREE.Mesh(capGeo, roofMat);
        cap.position.set(0, baseH - 0.01, 0);
        cap.castShadow = true;
        cap.receiveShadow = true;
        group.add(cap);

        roofHeight = baseH + capH;
      } else {
        const podH = 0.72;
        const podGeo = createBeveledBoxGeometry(0.82, podH, 0.82, 0.035, 0.015);
        const podium = new THREE.Mesh(podGeo, facadeMat);
        podium.castShadow = true;
        podium.receiveShadow = true;
        group.add(podium);

        const podTrimGeo = createBeveledBoxGeometry(0.85, 0.06, 0.85, 0.02, 0.01);
        const podTrim = new THREE.Mesh(podTrimGeo, roofMat);
        podTrim.position.set(0, podH - 0.02, 0);
        group.add(podTrim);

        const midH = 0.78;
        const midGeo = createBeveledBoxGeometry(0.68, midH, 0.68, 0.03, 0.015);
        const midTower = new THREE.Mesh(midGeo, facadeMat);
        midTower.position.set(0, podH, 0);
        midTower.castShadow = true;
        midTower.receiveShadow = true;
        group.add(midTower);

        const topH = 0.48;
        const topGeo = createBeveledBoxGeometry(0.56, topH, 0.56, 0.03, 0.015);
        const topTower = new THREE.Mesh(topGeo, facadeMat);
        topTower.position.set(0, podH + midH - 0.02, 0);
        topTower.castShadow = true;
        topTower.receiveShadow = true;
        group.add(topTower);

        const crownGeo = createBeveledBoxGeometry(0.6, 0.07, 0.6, 0.02, 0.01);
        const crown = new THREE.Mesh(crownGeo, roofMat);
        crown.position.set(0, podH + midH + topH - 0.04, 0);
        group.add(crown);

        roofHeight = podH + midH + topH + 0.03;
      }
    } else if (kind === "com") {
      if (level === 1) {
        const shopH = 0.74;
        const shopGeo = createBeveledBoxGeometry(0.76, shopH, 0.74, 0.03, 0.015);
        const shop = new THREE.Mesh(shopGeo, facadeMat);
        shop.castShadow = true;
        shop.receiveShadow = true;
        group.add(shop);

        const awningGeo = createBeveledBoxGeometry(0.66, 0.08, 0.14, 0.02, 0.01);
        const awningMat = variant === 0 ? this.comAwningMatA : this.comAwningMatB;
        const awning = new THREE.Mesh(awningGeo, awningMat);
        awning.position.set(0, 0.28, 0.39);
        awning.castShadow = true;
        group.add(awning);

        const corniceGeo = createBeveledBoxGeometry(0.8, 0.07, 0.78, 0.025, 0.01);
        const cornice = new THREE.Mesh(corniceGeo, this.comTrimMat);
        cornice.position.set(0, shopH - 0.02, 0);
        group.add(cornice);

        roofHeight = shopH + 0.05;
      } else if (level === 2) {
        const baseH = 0.95;
        const baseGeo = createBeveledBoxGeometry(0.8, baseH, 0.8, 0.035, 0.015);
        const base = new THREE.Mesh(baseGeo, facadeMat);
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        const bandGeo = createBeveledBoxGeometry(0.83, 0.055, 0.83, 0.02, 0.01);
        const band = new THREE.Mesh(bandGeo, this.comTrimMat);
        band.position.set(0, baseH - 0.02, 0);
        group.add(band);

        const upperH = 0.52;
        const upperGeo = createBeveledBoxGeometry(0.64, upperH, 0.64, 0.03, 0.015);
        const upper = new THREE.Mesh(upperGeo, facadeMat);
        upper.position.set(0, baseH, 0);
        upper.castShadow = true;
        upper.receiveShadow = true;
        group.add(upper);

        roofHeight = baseH + upperH;
      } else {
        const podH = 0.75;
        const podGeo = createBeveledBoxGeometry(0.84, podH, 0.84, 0.035, 0.015);
        const pod = new THREE.Mesh(podGeo, facadeMat);
        pod.castShadow = true;
        pod.receiveShadow = true;
        group.add(pod);

        const shaftH = 0.92;
        const shaftGeo = createBeveledBoxGeometry(0.68, shaftH, 0.68, 0.03, 0.015);
        const shaft = new THREE.Mesh(shaftGeo, facadeMat);
        shaft.position.set(0, podH - 0.02, 0);
        shaft.castShadow = true;
        shaft.receiveShadow = true;
        group.add(shaft);

        const crownH = 0.56;
        const crownGeo = createBeveledBoxGeometry(0.54, crownH, 0.54, 0.025, 0.015);
        const crown = new THREE.Mesh(crownGeo, facadeMat);
        crown.position.set(0, podH + shaftH - 0.04, 0);
        crown.castShadow = true;
        crown.receiveShadow = true;
        group.add(crown);

        const rimGeo = createBeveledBoxGeometry(0.58, 0.06, 0.58, 0.02, 0.01);
        const rim = new THREE.Mesh(rimGeo, this.comTrimMat);
        rim.position.set(0, podH + shaftH + crownH - 0.06, 0);
        group.add(rim);

        roofHeight = podH + shaftH + crownH;
      }
    } else {
      const addChimney = (cx: number, cz: number, baseH: number, stackH: number) => {
        const stackGeo = new THREE.CylinderGeometry(0.052, 0.075, stackH, 10);
        const stack = new THREE.Mesh(stackGeo, this.indChimneyMat);
        stack.position.set(cx, baseH + stackH / 2 - 0.02, cz);
        stack.castShadow = true;
        group.add(stack);

        const rimGeo = new THREE.CylinderGeometry(0.062, 0.062, 0.05, 10);
        const rim = new THREE.Mesh(rimGeo, this.indChimneyRimMat);
        rim.position.set(cx, baseH + stackH - 0.03, cz);
        group.add(rim);

        const puffGeo = new THREE.SphereGeometry(0.065, 8, 6);
        const puff = new THREE.Mesh(puffGeo, this.steamMat);
        puff.position.set(cx, baseH + stackH + 0.08, cz);
        puff.userData = { baseY: baseH + stackH + 0.06, phase: (cx + cz) * 7 };
        group.add(puff);
        steamPuffs.push(puff);
      };

      if (level === 1) {
        const hallH = 0.62;
        const hallGeo = createBeveledBoxGeometry(0.76, hallH, 0.68, 0.03, 0.015);
        const hall = new THREE.Mesh(hallGeo, facadeMat);
        hall.castShadow = true;
        hall.receiveShadow = true;
        group.add(hall);

        const roofGeo = createBeveledBoxGeometry(0.8, 0.07, 0.72, 0.02, 0.01);
        const roof = new THREE.Mesh(roofGeo, this.indRoofMat);
        roof.position.set(0, hallH - 0.01, 0);
        group.add(roof);

        addChimney(0.22, -0.18, hallH, 0.42);
        roofHeight = hallH + 0.06;
      } else if (level === 2) {
        const hallH = 0.88;
        const hallGeo = createBeveledBoxGeometry(0.8, hallH, 0.56, 0.03, 0.015);
        const hall = new THREE.Mesh(hallGeo, facadeMat);
        hall.position.set(0, 0, 0.08);
        hall.castShadow = true;
        hall.receiveShadow = true;
        group.add(hall);

        const siloGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.76, 12);
        const silo = new THREE.Mesh(siloGeo, this.indSiloMat);
        silo.position.set(-0.2, 0.38, -0.22);
        silo.castShadow = true;
        group.add(silo);

        addChimney(0.18, -0.22, 0.5, 0.65);
        addChimney(0.3, -0.22, 0.5, 0.52);
        roofHeight = hallH + 0.05;
      } else {
        const baseH = 0.82;
        const baseGeo = createBeveledBoxGeometry(0.84, baseH, 0.84, 0.03, 0.015);
        const base = new THREE.Mesh(baseGeo, facadeMat);
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        const upperH = 0.62;
        const upperGeo = createBeveledBoxGeometry(0.56, upperH, 0.54, 0.025, 0.015);
        const upper = new THREE.Mesh(upperGeo, facadeMat);
        upper.position.set(-0.08, baseH - 0.02, 0.08);
        upper.castShadow = true;
        upper.receiveShadow = true;
        group.add(upper);

        addChimney(0.24, -0.22, baseH, 0.72);
        addChimney(0.24, 0.06, baseH, 0.58);
        roofHeight = baseH + upperH;
      }
    }

    return { bodyGroup: group, roofHeight, steamPuffs };
  }

  private createRooftopGardenMesh(seed: number): {
    gardenGroup: THREE.Group;
    swayTargets: THREE.Object3D[];
  } {
    const group = new THREE.Group();
    const swayTargets: THREE.Object3D[] = [];

    const deck = new THREE.Mesh(this.gardenDeckGeo, this.gardenDeckMat);
    deck.position.set(0, 0, 0);
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    const lawn = new THREE.Mesh(this.gardenLawnGeo, this.gardenLawnMat);
    lawn.position.set(0, 0.03, 0);
    lawn.receiveShadow = true;
    group.add(lawn);

    const northHedge = new THREE.Mesh(this.hedgeLongGeo, this.hedgeMat);
    northHedge.position.set(0, 0.065, -0.24);
    group.add(northHedge);

    const southHedge = new THREE.Mesh(this.hedgeLongGeo, this.hedgeMat);
    southHedge.position.set(0, 0.065, 0.24);
    group.add(southHedge);

    const westHedge = new THREE.Mesh(this.hedgeShortGeo, this.hedgeMat);
    westHedge.position.set(-0.24, 0.065, 0);
    group.add(westHedge);

    const eastHedge = new THREE.Mesh(this.hedgeShortGeo, this.hedgeMat);
    eastHedge.position.set(0.24, 0.065, 0);
    group.add(eastHedge);

    const canopyMats = [this.canopyMatA, this.canopyMatB, this.canopyMatC];
    const treePlacements = [
      { x: -0.11, z: -0.09, big: true },
      { x: 0.12, z: 0.09, big: false },
      { x: -0.09, z: 0.11, big: false },
    ];

    treePlacements.forEach((tp, idx) => {
      const treePivot = new THREE.Group();
      treePivot.position.set(tp.x, 0.06, tp.z);

      const trunk = new THREE.Mesh(this.trunkGeo, this.trunkMat);
      trunk.position.set(0, 0.065, 0);
      trunk.castShadow = true;
      treePivot.add(trunk);

      const cMat = canopyMats[(seed + idx) % canopyMats.length];
      const canopy = new THREE.Mesh(
        tp.big ? this.sphereCanopyGeoA : this.sphereCanopyGeoB,
        cMat,
      );
      canopy.position.set(0, tp.big ? 0.18 : 0.15, 0);
      canopy.castShadow = true;
      treePivot.add(canopy);

      group.add(treePivot);
      swayTargets.push(treePivot);
    });

    const flowerCoords = [
      [0.11, -0.11, 0],
      [0.15, -0.06, 1],
      [-0.02, 0.01, 2],
      [0.03, -0.13, 0],
      [-0.14, 0.02, 1],
      [0.02, 0.14, 2],
    ];
    for (const [fx, fz, colorIdx] of flowerCoords) {
      const flowerPivot = new THREE.Group();
      flowerPivot.position.set(fx, 0.075, fz);
      const fl = new THREE.Mesh(
        this.flowerGeo,
        this.flowerMats[(seed + colorIdx) % this.flowerMats.length],
      );
      fl.position.set(0, 0.02, 0);
      flowerPivot.add(fl);
      group.add(flowerPivot);
      swayTargets.push(flowerPivot);
    }

    return { gardenGroup: group, swayTargets };
  }

  private createNoRoadFlagGroup(): THREE.Group {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(this.flagPoleGeo, this.trimCreamMat);
    pole.position.set(0, 0.11, 0);
    group.add(pole);

    const badge = new THREE.Mesh(this.flagBadgeGeo, this.flagMat);
    badge.position.set(0, 0.2, 0);
    group.add(badge);
    return group;
  }

  private updateCameraTransform(withIdleBob: boolean = false) {
    const yaw = this.currentYaw + (withIdleBob ? this.idleBobYaw : 0);
    const bobY = withIdleBob ? this.idleBobOffsetY : 0;
    const horiz = Math.cos(this.pitch) * this.cameraDistance;
    const vert = Math.sin(this.pitch) * this.cameraDistance;

    this.camera.position.set(
      this.target.x + Math.sin(yaw) * horiz,
      this.target.y + vert + bobY,
      this.target.z + Math.cos(yaw) * horiz,
    );
    this.camera.lookAt(this.target.x, this.target.y + bobY * 0.35, this.target.z);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /**
   * Smoothly rotates the isometric camera by 90-degree steps with an eased transition.
   */
  public rotateStep(deltaSteps: number) {
    this.yawIndex = (this.yawIndex + deltaSteps + 4) % 4;
    this.yawAnimFrom = this.currentYaw;
    this.yawAnimTo = this.yawAnimTo + deltaSteps * (Math.PI / 2);

    if (this.reducedMotion) {
      this.currentYaw = this.yawAnimTo;
      this.yawAnimStartAt = 0;
      this.updateCameraTransform(false);
    } else {
      this.yawAnimStartAt = performance.now();
    }
  }

  public zoomBy(factor: number) {
    this.camera.zoom = Math.max(0.45, Math.min(3.5, this.camera.zoom * factor));
    this.camera.updateProjectionMatrix();
  }

  private computeRoadTrafficTint(load: number): THREE.Color {
    if (load <= 1.2) {
      return this.tempColor.setHex(0xffffff);
    }
    const normalized = Math.min(1, (load - 1.2) / 6.5);
    return this.tempColor.setHex(0xffffff).lerp(new THREE.Color(0xffb4a2), normalized * 0.45);
  }

  private computeRoadMask(
    state: GameState,
    x: number,
    y: number,
    extraRoadSet?: Set<string>,
  ): number {
    const isRoadAt = (gx: number, gy: number) => {
      if (gx < 0 || gx >= state.gridSize || gy < 0 || gy >= state.gridSize) return false;
      return state.grid[gy][gx].kind === "road" || Boolean(extraRoadSet?.has(`${gx},${gy}`));
    };
    let mask = 0;
    if (isRoadAt(x, y - 1)) mask |= 1; // North
    if (isRoadAt(x + 1, y)) mask |= 2; // East
    if (isRoadAt(x, y + 1)) mask |= 4; // South
    if (isRoadAt(x - 1, y)) mask |= 8; // West
    return mask;
  }

  public syncFromState() {
    const state = this.getState();
    const seenKeys = new Set<string>();
    const now = performance.now();

    for (let y = 0; y < state.gridSize; y++) {
      for (let x = 0; x < state.gridSize; x++) {
        const tile = state.grid[y][x];
        const mesh = this.tileMeshes[y]?.[x];
        if (!mesh) continue;

        const mat = mesh.material as THREE.MeshLambertMaterial;

        if (tile.kind === "road") {
          const mask = this.computeRoadMask(state, x, y);
          const roadTex = this.getRoadTextureForMask(mask);
          if (mat.map !== roadTex) {
            mat.map = roadTex;
            mat.needsUpdate = true;
          }
          mat.color.copy(this.computeRoadTrafficTint(tile.load ?? 0));
          mesh.geometry = this.roadGeo;
          mesh.position.y = -0.07;
        } else if (tile.kind === "res" || tile.kind === "com" || tile.kind === "ind") {
          const zTex = this.zonePadTextures.get(tile.kind) ?? null;
          if (mat.map !== zTex) {
            mat.map = zTex;
            mat.needsUpdate = true;
          }
          mat.color.setHex(tile.building ? ZONE_PAD_COLORS[tile.kind] : 0xffffff);
          mesh.geometry = this.tileGeo;
          mesh.position.y = -0.1;
        } else {
          if (mat.map !== null) {
            mat.map = null;
            mat.needsUpdate = true;
          }
          mat.color.setHex((x + y) % 2 === 0 ? GROUND_CREAM_A : GROUND_CREAM_B);
          mesh.geometry = this.tileGeo;
          mesh.position.y = -0.1;
        }

        // Sync building visuals
        if (
          tile.building &&
          tile.building.level > 0 &&
          (tile.kind === "res" || tile.kind === "com" || tile.kind === "ind")
        ) {
          const key = `${x},${y}`;
          seenKeys.add(key);

          const { wx, wz } = gridToWorld(x, y, state.gridSize);
          let visual = this.buildingVisuals.get(key);
          const seed = tileSeed(x, y);

          if (!visual || visual.kind !== tile.kind) {
            if (visual) {
              this.buildingGroup.remove(visual.rootGroup);
            }
            const rootGroup = new THREE.Group();
            rootGroup.position.set(wx, 0.04, wz);
            this.buildingGroup.add(rootGroup);

            const { bodyGroup, roofHeight, steamPuffs } = this.createBuildingArchitecture(
              tile.kind,
              tile.building.level,
              seed,
            );
            const animateIn = this.hasDoneInitialSync && !this.reducedMotion;
            const initialScale = animateIn ? 0.08 : 1;
            bodyGroup.scale.set(animateIn ? 0.72 : 1, initialScale, animateIn ? 0.72 : 1);
            rootGroup.add(bodyGroup);

            visual = {
              key,
              gx: x,
              gy: y,
              kind: tile.kind,
              level: tile.building.level,
              seed,
              currentScaleY: initialScale,
              targetScaleY: 1,
              spawnedAt: animateIn ? now : now - 2000,
              roofHeight,
              rootGroup,
              bodyGroup,
              gardenGroup: null,
              swayTargets: [],
              steamPuffs,
              flagGroup: null,
            };
            this.buildingVisuals.set(key, visual);
          } else if (visual.level !== tile.building.level) {
            visual.rootGroup.remove(visual.bodyGroup);
            const { bodyGroup, roofHeight, steamPuffs } = this.createBuildingArchitecture(
              tile.kind,
              tile.building.level,
              seed,
            );
            const animateUpgrade = !this.reducedMotion;
            visual.level = tile.building.level;
            visual.currentScaleY = animateUpgrade ? 0.52 : 1;
            visual.targetScaleY = 1;
            visual.spawnedAt = animateUpgrade ? now : now - 2000;
            visual.roofHeight = roofHeight;
            visual.bodyGroup = bodyGroup;
            visual.steamPuffs = steamPuffs;
            bodyGroup.scale.set(
              animateUpgrade ? 0.85 : 1,
              visual.currentScaleY,
              animateUpgrade ? 0.85 : 1,
            );
            visual.rootGroup.add(bodyGroup);
          }

          // Rooftop garden sync
          if (tile.building.garden && !visual.gardenGroup) {
            const { gardenGroup, swayTargets } = this.createRooftopGardenMesh(seed);
            const animateGarden = this.hasDoneInitialSync && !this.reducedMotion;
            const startScale = animateGarden ? 0.05 : 1;
            gardenGroup.position.set(0, visual.roofHeight * visual.currentScaleY, 0);
            gardenGroup.scale.set(startScale, startScale, startScale);
            visual.rootGroup.add(gardenGroup);
            visual.gardenGroup = gardenGroup;
            visual.swayTargets = swayTargets;
            visual.gardenPlantedAt = animateGarden ? now : now - 5000;
          } else if (!tile.building.garden && visual.gardenGroup) {
            visual.rootGroup.remove(visual.gardenGroup);
            visual.gardenGroup = null;
            visual.swayTargets = [];
          }

          // No road access flag sync
          if (tile.building.noRoadAccess && !visual.flagGroup) {
            const flagGroup = this.createNoRoadFlagGroup();
            flagGroup.position.set(0, visual.roofHeight * visual.currentScaleY + 0.22, 0);
            visual.rootGroup.add(flagGroup);
            visual.flagGroup = flagGroup;
          } else if (!tile.building.noRoadAccess && visual.flagGroup) {
            visual.rootGroup.remove(visual.flagGroup);
            visual.flagGroup = null;
          }
        }
      }
    }

    for (const [key, visual] of this.buildingVisuals.entries()) {
      if (!seenKeys.has(key)) {
        this.buildingGroup.remove(visual.rootGroup);
        this.buildingVisuals.delete(key);
      }
    }

    this.updateHighlightMeshes();
  }

  private updateCameraAnimations(now: number) {
    // 1. Eased camera rotation transition
    if (this.yawAnimStartAt > 0) {
      const elapsed = now - this.yawAnimStartAt;
      if (elapsed >= this.yawAnimDuration || this.reducedMotion) {
        this.currentYaw = this.yawAnimTo;
        this.yawAnimStartAt = 0;
      } else {
        const t = easeOutCubic(elapsed / this.yawAnimDuration);
        this.currentYaw = this.yawAnimFrom + (this.yawAnimTo - this.yawAnimFrom) * t;
      }
    }

    // 2. Gentle idle camera bob on the first-run screen
    const shouldBob =
      !this.reducedMotion &&
      Boolean(this.isFirstRunScreen?.()) &&
      !this.isPainting &&
      !this.isPanning &&
      !this.hoveredTile;

    if (shouldBob) {
      const targetBobY = Math.sin(now * 0.0017) * 0.22;
      const targetBobYaw = Math.sin(now * 0.00095) * 0.014;
      this.idleBobOffsetY += (targetBobY - this.idleBobOffsetY) * 0.08;
      this.idleBobYaw += (targetBobYaw - this.idleBobYaw) * 0.08;
    } else {
      this.idleBobOffsetY *= 0.82;
      this.idleBobYaw *= 0.82;
      if (Math.abs(this.idleBobOffsetY) < 0.001) this.idleBobOffsetY = 0;
      if (Math.abs(this.idleBobYaw) < 0.0002) this.idleBobYaw = 0;
    }

    this.updateCameraTransform(true);

    // 3. Subtle drifting cloud shadows over the island
    if (this.cloudShadowTexture && !this.reducedMotion) {
      this.cloudShadowTexture.offset.x = (now * 0.000014) % 1;
      this.cloudShadowTexture.offset.y = (now * 0.000009) % 1;
    }
  }

  private updateBuildingAndGardenAnimations(now: number) {
    for (const visual of this.buildingVisuals.values()) {
      const ageMs = Math.max(0, now - visual.spawnedAt);
      const popDuration = 540;

      if (!this.reducedMotion && ageMs < popDuration) {
        const t = ageMs / popDuration;
        const backCurve = easeOutBack(t, 1.85);
        const sy = Math.max(0.08, backCurve);
        const sxz = 0.74 + 0.26 * Math.min(1.06, backCurve);
        visual.currentScaleY = sy;
        visual.bodyGroup.scale.set(sxz, sy, sxz);
      } else {
        visual.currentScaleY = visual.targetScaleY;
        visual.bodyGroup.scale.set(1, visual.currentScaleY, 1);
      }

      const currentTopY = visual.roofHeight * visual.currentScaleY;

      // Industrial chimney steam puff animation
      for (const puff of visual.steamPuffs) {
        const baseY = (puff.userData.baseY as number) ?? 0.8;
        if (this.reducedMotion) {
          puff.position.y = baseY + 0.1;
          puff.scale.setScalar(0.95);
        } else {
          const phase = (puff.userData.phase as number) ?? 0;
          const cycle = ((now * 0.0008 + phase) % 1 + 1) % 1;
          puff.position.y = baseY + cycle * 0.26;
          const s = 0.65 + Math.sin(cycle * Math.PI) * 0.65;
          puff.scale.set(s, s, s);
        }
      }

      // Rooftop garden grow-in with overshoot + staggered tree/flower bloom + wind sway
      if (visual.gardenGroup) {
        const plantedAt = visual.gardenPlantedAt ?? now - 5000;
        const elapsed = Math.max(0, now - plantedAt);
        const growDuration = 780;
        visual.gardenGroup.position.set(0, currentTopY, 0);

        if (this.reducedMotion || elapsed >= growDuration) {
          visual.gardenGroup.scale.set(1, 1, 1);
          const windBase = now * 0.0028 + visual.gx * 0.65 + visual.gy * 0.45;
          for (let i = 0; i < visual.swayTargets.length; i++) {
            const st = visual.swayTargets[i];
            st.scale.set(1, 1, 1);
            if (this.reducedMotion) {
              st.rotation.set(0, 0, 0);
            } else {
              st.rotation.z = Math.sin(windBase + i * 1.1) * 0.095;
              st.rotation.x = Math.cos(windBase * 0.85 + i * 0.7) * 0.065;
            }
          }
        } else {
          const deckScale = Math.max(0.05, easeOutBack(Math.min(1, elapsed / 520), 1.65));
          visual.gardenGroup.scale.set(deckScale, deckScale, deckScale);

          for (let i = 0; i < visual.swayTargets.length; i++) {
            const st = visual.swayTargets[i];
            const delayMs = 90 + i * 45;
            const localT = Math.max(0, Math.min(1, (elapsed - delayMs) / 420));
            const itemScale = localT <= 0 ? 0.01 : Math.max(0.01, easeOutBack(localT, 2.0));
            st.scale.set(itemScale, itemScale, itemScale);
          }
        }
      }

      if (visual.flagGroup) {
        const bob = this.reducedMotion ? 0 : Math.sin(now * 0.005 + visual.gx) * 0.04;
        visual.flagGroup.position.set(0, currentTopY + 0.24 + bob, 0);
        if (!this.reducedMotion) {
          visual.flagGroup.rotation.y = now * 0.002;
        }
      }
    }
  }

  private updateParticlesAndFloaters(now: number) {
    // 1. Dust puff particles
    const aliveDust: DustParticle[] = [];
    for (const p of this.dustParticles) {
      const elapsed = now - p.bornAt;
      if (elapsed >= p.duration) {
        this.fxGroup.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        continue;
      }
      const progress = elapsed / p.duration;
      const dt = 0.016;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt * (1 - progress * 0.6);
      p.mesh.position.z += p.vz * dt;

      const scale = p.initialScale * (1 + progress * 0.7) * (1 - progress * 0.85);
      p.mesh.scale.setScalar(Math.max(0.01, scale));
      const mat = p.mesh.material as THREE.MeshLambertMaterial;
      mat.opacity = (1 - progress) * 0.82;
      aliveDust.push(p);
    }
    this.dustParticles = aliveDust;

    // 2. Floating '+$' labels
    const aliveLabels: FloatingLabel[] = [];
    for (const fl of this.floatingLabels) {
      const elapsed = now - fl.bornAt;
      if (elapsed >= fl.duration) {
        this.fxGroup.remove(fl.sprite);
        fl.material.dispose();
        fl.texture.dispose();
        continue;
      }
      const progress = elapsed / fl.duration;
      fl.sprite.position.y = fl.startY + (this.reducedMotion ? 0.35 : progress * 0.95);
      fl.material.opacity = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
      aliveLabels.push(fl);
    }
    this.floatingLabels = aliveLabels;

    // 3. Congestion color pulse on road tiles
    const state = this.getState();
    const pulse = this.reducedMotion ? 0.65 : 0.5 + 0.5 * Math.sin(now * 0.011);
    for (let y = 0; y < state.gridSize; y++) {
      for (let x = 0; x < state.gridSize; x++) {
        const tile = state.grid[y][x];
        if (tile.kind !== "road") continue;
        const mesh = this.tileMeshes[y]?.[x];
        if (!mesh) continue;
        const mat = mesh.material as THREE.MeshLambertMaterial;
        const load = tile.load ?? 0;
        if (load > 5) {
          mat.color.setHex(0xffffff).lerp(new THREE.Color(0xef4444), 0.42 + pulse * 0.5);
        } else if (load >= 2.2) {
          const severity = Math.min(1, (load - 2.2) / 2.8);
          mat.color
            .setHex(0xffffff)
            .lerp(new THREE.Color(0xf59e0b), severity * (0.25 + pulse * 0.35));
        } else {
          mat.color.copy(this.computeRoadTrafficTint(load));
        }
      }
    }

    // 4. Animated hover tile outline pulse
    const hoverPulse = this.reducedMotion ? 0 : Math.sin(now * 0.0075);
    const scalePulse = 1 + hoverPulse * 0.03;
    const yLift = 0.012 + (hoverPulse + 1) * 0.01;
    this.validOutlineMat.opacity = this.reducedMotion ? 0.88 : 0.76 + hoverPulse * 0.18;
    this.invalidOutlineMat.opacity = this.reducedMotion ? 0.95 : 0.82 + hoverPulse * 0.16;

    for (const outline of this.hoverOutlineMeshes) {
      const baseY = (outline.userData.baseY as number) ?? 0.05;
      outline.position.y = baseY + (this.reducedMotion ? 0 : yLift);
      outline.scale.set(scalePulse, 1, scalePulse);
    }
  }

  private updateCarInstances() {
    const traffic = this.getTraffic?.();
    if (!traffic) {
      this.carBodyMesh.count = 0;
      this.carCabinMesh.count = 0;
      this.carHeadlightMesh.count = 0;
      this.carBeamMesh.count = 0;
      return;
    }

    const state = this.getState();
    const alpha = this.getTickAlpha ? this.getTickAlpha() : 1;
    const count = Math.min(traffic.cars.length, MAX_CARS);

    this.carBodyMesh.count = count;
    this.carCabinMesh.count = count;
    this.carHeadlightMesh.count = count;
    this.carBeamMesh.count = this.currentNightFactor > 0.15 ? count : 0;

    for (let i = 0; i < count; i++) {
      const car = traffic.cars[i];
      const { gx, gy, dirX, dirY } = getCarInterpolatedTransform(car, alpha);
      const { wx, wz } = gridToWorld(gx, gy, state.gridSize);
      const yaw = Math.atan2(-dirY, dirX);

      this.dummyObj.position.set(wx, 0.1, wz);
      this.dummyObj.rotation.set(0, yaw, 0);
      this.dummyObj.updateMatrix();
      this.carBodyMesh.setMatrixAt(i, this.dummyObj.matrix);

      this.tempColor.setHex(car.color);
      this.carBodyMesh.setColorAt(i, this.tempColor);

      this.dummySubObj.position.set(wx - dirX * 0.02, 0.185, wz - dirY * 0.02);
      this.dummySubObj.rotation.set(0, yaw, 0);
      this.dummySubObj.updateMatrix();
      this.carCabinMesh.setMatrixAt(i, this.dummySubObj.matrix);

      this.dummySubObj.position.set(wx + dirX * 0.155, 0.14, wz + dirY * 0.155);
      this.dummySubObj.rotation.set(0, yaw, 0);
      this.dummySubObj.updateMatrix();
      this.carHeadlightMesh.setMatrixAt(i, this.dummySubObj.matrix);

      if (this.currentNightFactor > 0.15) {
        this.dummySubObj.position.set(wx + dirX * 0.16, 0.12, wz + dirY * 0.16);
        this.dummySubObj.rotation.set(0, yaw, 0);
        this.dummySubObj.updateMatrix();
        this.carBeamMesh.setMatrixAt(i, this.dummySubObj.matrix);
      }
    }

    this.carBodyMesh.instanceMatrix.needsUpdate = true;
    if (this.carBodyMesh.instanceColor) {
      this.carBodyMesh.instanceColor.needsUpdate = true;
    }
    this.carCabinMesh.instanceMatrix.needsUpdate = true;
    this.carHeadlightMesh.instanceMatrix.needsUpdate = true;
    if (this.currentNightFactor > 0.15) {
      this.carBeamMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Rebuilds the animated hover tile outline, selected tile ring, and translucent placement ghost preview
   * (turning translucent red when a placement is invalid or unaffordable).
   */
  public updateHighlightMeshes() {
    while (this.highlightGroup.children.length > 0) {
      const child = this.highlightGroup.children.pop()!;
      this.highlightGroup.remove(child);
    }
    this.hoverOutlineMeshes = [];
    this.ghostMeshes = [];

    const state = this.getState();
    const activeTool: ToolKind = this.getTool ? this.getTool() : "road";
    const toolUnlocked = this.isToolUnlocked ? this.isToolUnlocked(activeTool) : true;
    const selectedTile = this.getSelectedTile ? this.getSelectedTile() : null;

    // 1. Selected / inspected tile outline ring
    if (selectedTile) {
      const { wx, wz } = gridToWorld(selectedTile.x, selectedTile.y, state.gridSize);
      const selOutline = new THREE.Mesh(this.hoverFrameGeo, this.selectOutlineMat);
      selOutline.position.set(wx, 0.065, wz);
      this.highlightGroup.add(selOutline);
    }

    // 2. Hovered or dragged line tiles
    let tilesToHighlight: Array<{ x: number; y: number }> = [];
    if (this.isPainting && this.dragStartTile && this.hoveredTile) {
      tilesToHighlight = getStraightLineTiles(
        this.dragStartTile.x,
        this.dragStartTile.y,
        this.hoveredTile.x,
        this.hoveredTile.y,
      );
    } else if (this.hoveredTile) {
      tilesToHighlight = [this.hoveredTile];
    }

    if (tilesToHighlight.length === 0) return;

    const previewRoadSet = new Set<string>();
    if (activeTool === "road") {
      for (const pt of tilesToHighlight) {
        previewRoadSet.add(`${pt.x},${pt.y}`);
      }
    }

    let cumulativeCost = 0;

    for (const t of tilesToHighlight) {
      const tile = state.grid[t.y]?.[t.x];
      if (!tile) continue;
      const { wx, wz } = gridToWorld(t.x, t.y, state.gridSize);

      let isValid = toolUnlocked;
      let isNoOp = false;

      if (activeTool === "road") {
        if (tile.kind === "road") {
          isNoOp = true;
        } else {
          cumulativeCost += COSTS.road;
          if (state.money < cumulativeCost) {
            isValid = false;
          }
        }
      } else if (isZoneKind(activeTool)) {
        if (tile.kind === activeTool) {
          isNoOp = true;
        } else if (tile.kind === "road") {
          isValid = false;
        } else {
          cumulativeCost += COSTS.zone;
          if (state.money < cumulativeCost) {
            isValid = false;
          }
        }
      } else if (activeTool === "garden") {
        const canHoldGarden =
          (tile.kind === "res" || tile.kind === "com") &&
          Boolean(tile.building && tile.building.level >= 1 && !tile.building.garden);
        if (!canHoldGarden) {
          isValid = false;
        } else {
          cumulativeCost += COSTS.garden;
          if (state.money < cumulativeCost) {
            isValid = false;
          }
        }
      } else if (activeTool === "bulldoze") {
        if (tile.kind === "empty" && !tile.building) {
          isNoOp = true;
        } else {
          cumulativeCost += COSTS.bulldoze;
          if (state.money < cumulativeCost) {
            isValid = false;
          }
        }
      }

      // Animated 3D hover tile outline frame
      const outlineMat = !isValid ? this.invalidOutlineMat : this.validOutlineMat;
      const outlineMesh = new THREE.Mesh(this.hoverFrameGeo, outlineMat);
      const baseY = tile.kind === "road" ? 0.08 : 0.055;
      outlineMesh.position.set(wx, baseY, wz);
      outlineMesh.userData = { baseY };
      this.highlightGroup.add(outlineMesh);
      this.hoverOutlineMeshes.push(outlineMesh);

      // Placement ghost preview mesh
      if (activeTool === "road") {
        const mask = this.computeRoadMask(state, t.x, t.y, previewRoadSet);
        const roadTex = this.getRoadTextureForMask(mask);
        const ghostMat = new THREE.MeshBasicMaterial({
          map: roadTex,
          color: !isValid ? 0xef4444 : isNoOp ? 0xcbd5e1 : 0xa7f3d0,
          transparent: true,
          opacity: !isValid ? 0.68 : isNoOp ? 0.35 : 0.62,
          depthWrite: false,
        });
        const ghostRoad = new THREE.Mesh(this.roadGeo, ghostMat);
        ghostRoad.position.set(wx, -0.04, wz);
        this.highlightGroup.add(ghostRoad);
        this.ghostMeshes.push(ghostRoad);
      } else if (isZoneKind(activeTool) && !isNoOp) {
        const ghostColor = !isValid ? 0xef4444 : ZONE_PAD_COLORS[activeTool];
        const ghostMat = new THREE.MeshBasicMaterial({
          color: ghostColor,
          transparent: true,
          opacity: !isValid ? 0.62 : 0.45,
          depthWrite: false,
        });
        const ghostBox = new THREE.Mesh(
          !isValid ? this.roadGeo : this.ghostZoneBoxGeo,
          ghostMat,
        );
        ghostBox.position.set(wx, !isValid ? -0.04 : 0.04, wz);
        this.highlightGroup.add(ghostBox);
        this.ghostMeshes.push(ghostBox);
      } else if (activeTool === "garden") {
        const visual = this.buildingVisuals.get(`${t.x},${t.y}`);
        if (isValid && visual) {
          const ghostMat = new THREE.MeshBasicMaterial({
            color: 0x52b788,
            transparent: true,
            opacity: 0.62,
            depthWrite: false,
          });
          const ghostGarden = new THREE.Mesh(this.gardenDeckGeo, ghostMat);
          ghostGarden.position.set(wx, visual.roofHeight + 0.05, wz);
          this.highlightGroup.add(ghostGarden);
          this.ghostMeshes.push(ghostGarden);
        } else if (!isValid) {
          const invalidSlab = new THREE.Mesh(this.roadGeo, this.invalidGhostSlabMat);
          invalidSlab.position.set(wx, visual ? visual.roofHeight + 0.05 : -0.04, wz);
          this.highlightGroup.add(invalidSlab);
          this.ghostMeshes.push(invalidSlab);
        }
      } else if (activeTool === "bulldoze" && !isNoOp) {
        const bulldozeMat = new THREE.MeshBasicMaterial({
          color: !isValid ? 0xef4444 : 0xf97316,
          transparent: true,
          opacity: 0.48,
          depthWrite: false,
        });
        const slab = new THREE.Mesh(this.roadGeo, bulldozeMat);
        slab.position.set(wx, -0.03, wz);
        this.highlightGroup.add(slab);
        this.ghostMeshes.push(slab);
      }
    }
  }

  public pickTileAtClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = new THREE.Vector3();
    const intersected = this.raycaster.ray.intersectPlane(this.pickPlane, hit);
    if (!intersected) return null;

    return worldToGrid(hit.x, hit.z, this.getState().gridSize);
  }

  public tileToScreen(gx: number, gy: number): { x: number; y: number } {
    const rect = this.domElement.getBoundingClientRect();
    const { wx, wz } = gridToWorld(gx, gy, this.getState().gridSize);
    const vec = new THREE.Vector3(wx, 0, wz);
    vec.project(this.camera);
    return {
      x: rect.left + ((vec.x + 1) / 2) * rect.width,
      y: rect.top + ((-vec.y + 1) / 2) * rect.height,
    };
  }

  private panByScreenDelta(dx: number, dy: number) {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.height <= 0) return;

    const unitsPerPixel = this.frustumSize / (rect.height * this.camera.zoom);
    const yaw = this.currentYaw;

    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));

    const pitchScale = 1 / Math.max(Math.sin(this.pitch), 0.35);
    this.target.addScaledVector(right, -dx * unitsPerPixel);
    this.target.addScaledVector(forward, dy * unitsPerPixel * pitchScale);

    const limit = this.getState().gridSize * 0.65;
    this.target.x = Math.max(-limit, Math.min(limit, this.target.x));
    this.target.z = Math.max(-limit, Math.min(limit, this.target.z));
    this.updateCameraTransform(false);
  }

  private bindEvents() {
    const el = this.domElement;

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent) => {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 2 || e.button === 2 || e.button === 1) {
        this.isPanning = true;
        this.isPainting = false;
        this.dragStartTile = null;
        this.lastPanClient = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 0) {
        this.pointerDownClient = { x: e.clientX, y: e.clientY };
        const picked = this.pickTileAtClient(e.clientX, e.clientY);
        this.hoveredTile = picked;
        this.onHoverTile?.(picked);
        if (picked) {
          this.isPainting = true;
          this.dragStartTile = picked;
          this.onStrokeStart?.();
          this.onPaintTiles([picked]);
          this.updateHighlightMeshes();
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (this.activePointers.has(e.pointerId)) {
        const prev = this.activePointers.get(e.pointerId)!;
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.activePointers.size === 2) {
          this.panByScreenDelta((e.clientX - prev.x) * 0.5, (e.clientY - prev.y) * 0.5);
          return;
        }
      }

      if (this.isPanning) {
        const dx = e.clientX - this.lastPanClient.x;
        const dy = e.clientY - this.lastPanClient.y;
        this.lastPanClient = { x: e.clientX, y: e.clientY };
        this.panByScreenDelta(dx, dy);
        return;
      }

      const picked = this.pickTileAtClient(e.clientX, e.clientY);
      const changedHover =
        picked?.x !== this.hoveredTile?.x || picked?.y !== this.hoveredTile?.y;
      this.hoveredTile = picked;
      if (changedHover) {
        this.onHoverTile?.(picked);
      }

      if (this.isPainting && this.dragStartTile && picked) {
        const lineTiles = getStraightLineTiles(
          this.dragStartTile.x,
          this.dragStartTile.y,
          picked.x,
          picked.y,
        );
        this.onPaintTiles(lineTiles);
      }

      if (changedHover) {
        this.updateHighlightMeshes();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);

      if (this.isPainting && this.dragStartTile) {
        const picked = this.pickTileAtClient(e.clientX, e.clientY) ?? this.hoveredTile;
        if (picked) {
          const lineTiles = getStraightLineTiles(
            this.dragStartTile.x,
            this.dragStartTile.y,
            picked.x,
            picked.y,
          );
          this.onPaintTiles(lineTiles);

          if (
            this.pointerDownClient &&
            Math.hypot(
              e.clientX - this.pointerDownClient.x,
              e.clientY - this.pointerDownClient.y,
            ) < 8
          ) {
            this.onSelectTile?.(picked);
          }
        }
        this.onStrokeEnd?.();
      }

      if (this.activePointers.size === 0) {
        this.isPanning = false;
        this.isPainting = false;
        this.dragStartTile = null;
        this.pointerDownClient = null;
        this.updateHighlightMeshes();
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        this.panByScreenDelta(-e.deltaX, -e.deltaY);
        return;
      }
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoomBy(zoomFactor);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
      ) {
        return;
      }
      if (e.key === "q" || e.key === "Q") {
        this.rotateStep(-1);
      } else if (e.key === "e" || e.key === "E") {
        this.rotateStep(1);
      }
    };

    const handleResize = () => {
      const width = Math.max(this.container.clientWidth, 1);
      const height = Math.max(this.container.clientHeight, 1);
      const aspect = width / height;

      this.camera.left = (-this.frustumSize * aspect) / 2;
      this.camera.right = (this.frustumSize * aspect) / 2;
      this.camera.top = this.frustumSize / 2;
      this.camera.bottom = -this.frustumSize / 2;
      this.camera.updateProjectionMatrix();

      if (this.renderer) {
        this.renderer.setSize(width, height);
      }
    };

    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", handleResize);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(handleResize);
      this.resizeObserver.observe(this.container);
    }

    this.cleanupFns.push(() => {
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", handleResize);
      this.resizeObserver?.disconnect();
    });
  }

  private cleanupFns: Array<() => void> = [];

  private startLoop() {
    const animate = (now: number) => {
      this.animationFrameId = requestAnimationFrame(animate);
      const state = this.getState();
      const alpha = this.getTickAlpha ? this.getTickAlpha() : 0;
      const continuousHour = (8 + (state.tick % 24) + alpha) % 24;
      this.updateCameraAnimations(now);
      this.updateDayNightLighting(continuousHour);
      this.updateBuildingAndGardenAnimations(now);
      this.updateParticlesAndFloaters(now);
      this.updateCarInstances();
      if (this.renderer) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.animationFrameId = requestAnimationFrame(animate);
  }

  public dispose() {
    cancelAnimationFrame(this.animationFrameId);
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
    this.renderer?.dispose();
  }
}
