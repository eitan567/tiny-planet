import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sun, CloudRain, Snowflake, Wind, Volume2, VolumeX, RotateCcw, Plane, User, Triangle as Parachute } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
type Weather = 'clear' | 'rain' | 'snow' | 'windy';
type ObstacleShape =
  | { type: 'sphere'; center: THREE.Vector3; radius: number }
  | { type: 'box'; center: THREE.Vector3; halfSize: THREE.Vector3 };
type ObstacleCollider = {
  object: THREE.Object3D;
  shapes: ObstacleShape[];
};

declare global {
  interface Window {
    render_game_to_text?: () => string;
  }
}

// --- Constants ---
const PLANET_RADIUS = 5;
const TREE_COUNT = 180;
const HOUSE_COUNT = 45;
const CLOUD_COUNT = 30;
const WATER_LEVEL = 0.998; // Relative to PLANET_RADIUS
const AUTO_FIRE_START_DELAY_MS = 280;
const AUTO_FIRE_INTERVAL_MS = 120;
const PLAYER_COLLISION_RADIUS = 0.18;
const GRENADE_FUSE_FRAMES = 96;
const GRENADE_ARM_FRAMES = 10;
const GRENADE_THROW_COOLDOWN_FRAMES = 20;

// --- Helper Functions ---
const getTerrainHeight = (v: THREE.Vector3) => {
  // Use a combination of sine waves with non-integer frequencies to simulate organic noise
  const f1 = 0.4, f2 = 1.3, f3 = 2.7;
  
  const n1 = Math.sin(v.x * f1 + Math.cos(v.y * f1)) * Math.cos(v.z * f1 + Math.sin(v.x * f1));
  const n2 = Math.sin(v.x * f2 + v.y * f2) * Math.cos(v.z * f2 - v.x * f2);
  const n3 = Math.sin(v.x * f3) * Math.cos(v.y * f3 + v.z * f3);

  // Combine: mostly low frequency for gentle continents, less high frequency
  let d = (n1 * 0.6) + (n2 * 0.3) + (n3 * 0.1);
  
  // Bias upwards to create more landmass than ocean
  d += 0.35; 
  
  // Scale to make hills gentle and proportional to the planet (radius 5)
  d *= 0.3;

  // Smooth out the deep valleys so oceans aren't infinitely deep
  if (d < -0.05) {
    d = -0.05 + (d + 0.05) * 0.4;
  }
  
  return d; 
};

const disposeSceneObject = (object: THREE.Object3D) => {
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) {
      child.material.forEach(material => material.dispose());
      return;
    }
    child.material.dispose();
  });
};

const getStableSurfaceDirection = (up: THREE.Vector3, preferred?: THREE.Vector3) => {
  const candidates = [
    preferred,
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(1, 0, 0),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const projected = candidate.clone().projectOnPlane(up);
    if (projected.lengthSq() > 1e-6) {
      return projected.normalize();
    }
  }

  return new THREE.Vector3(1, 0, 0);
};

const getBoxSignedDistance = (point: THREE.Vector3, center: THREE.Vector3, halfSize: THREE.Vector3) => {
  const dx = Math.abs(point.x - center.x) - halfSize.x;
  const dy = Math.abs(point.y - center.y) - halfSize.y;
  const dz = Math.abs(point.z - center.z) - halfSize.z;
  const outside = new THREE.Vector3(
    Math.max(dx, 0),
    Math.max(dy, 0),
    Math.max(dz, 0)
  ).length();
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside;
};

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [weather, setWeather] = useState<Weather>('clear');
  const [isRotating, setIsRotating] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(0.3);
  
  // Flight Controls
  const [flightMode, setFlightMode] = useState(false);
  const [cameraView, setCameraView] = useState<'orbit' | 'third-person' | 'cockpit'>('orbit');
  const [fpsMode, setFpsMode] = useState(false);
  const [showFpsInstructions, setShowFpsInstructions] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs to track latest state inside the animation loop (avoids stale closures)
  const isRotatingRef = useRef(isRotating);
  const weatherRef = useRef(weather);
  useEffect(() => { isRotatingRef.current = isRotating; }, [isRotating]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);

  // Ambient nature sounds (local files)
  const weatherSounds: Record<Weather, string> = {
    clear: '/audio/forest-birds.mp3', // Forest with birds
    rain: '/audio/rain.mp3',          // Soft rain
    snow: '/audio/wind.mp3',          // Gentle winter wind
    windy: '/audio/wind.mp3',         // Wind
  };

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.loop = true;
    }

    const audio = audioRef.current;
    audio.src = weatherSounds[weather];
    audio.volume = volume;
    audio.muted = isMuted;

    if (!isMuted) {
      audio.play().catch(err => console.log("Audio play blocked:", err));
    } else {
      audio.pause();
    }
  }, [weather]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = isMuted;
      audioRef.current.volume = volume;
      if (!isMuted) {
        audioRef.current.play().catch(err => console.log("Audio play blocked:", err));
      } else {
        audioRef.current.pause();
      }
    }
  }, [isMuted, volume]);

  // Three.js refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const orthoCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const perspCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const weaponGroupRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const planetRef = useRef<THREE.Group | null>(null);
  const cloudsRef = useRef<THREE.Group | null>(null);
  const airplanePivotRef = useRef<THREE.Group | null>(null);
  const airplaneTiltRef = useRef<THREE.Group | null>(null);
  const birdPivotsRef = useRef<THREE.Group[]>([]);
  const weatherParticlesRef = useRef<THREE.Points | null>(null);
  const starfieldRef = useRef<THREE.Points | null>(null);
  const houseWindowMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const stormCloudsRef = useRef<THREE.Group[]>([]);
  const particleCloudMapRef = useRef<Int16Array>(new Int16Array(0)); // particle index → cloud child index
  const particleFallProgressRef = useRef<Float32Array>(new Float32Array(0)); // 0 = at cloud, 1 = at surface
  const particleOffsetRef = useRef<Float32Array>(new Float32Array(0)); // [latX, latZ, latX, latZ...]
  const celestialGroupRef = useRef<THREE.Group | null>(null);
  const obstacleCollidersRef = useRef<ObstacleCollider[]>([]);

  // Flight Interaction Refs
  const keysRef = useRef<{ [key: string]: boolean }>({});
  const planeSpeedRef = useRef(0);
  const flightModeRef = useRef(flightMode);
  const cameraViewRef = useRef(cameraView);
  const fpsModeRef = useRef(fpsMode);
  const activeModeRef = useRef<'orbit' | 'flight' | 'fps'>('orbit');
  const shouldResetOrbitCameraRef = useRef(false);

  // FPS Character Refs
  const characterPosRef = useRef(new THREE.Vector3());
  const characterQuatRef = useRef(new THREE.Quaternion());
  const characterVelocityRef = useRef(new THREE.Vector3());
  const fpsForwardRef = useRef(new THREE.Vector3(0, 0, -1));
  const fpsPitchRef = useRef(0);

  // Shooting Refs
  const raycasterRef = useRef(new THREE.Raycaster());
  const smokeParticlesRef = useRef<{ mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; maxLife: number }[]>([]);
  const bulletTracersRef = useRef<{ mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; maxLife: number }[]>([]);
  const grenadesRef = useRef<{ mesh: THREE.Mesh; velocity: THREE.Vector3; life: number }[]>([]);
  const grenadeBurstsRef = useRef<{ mesh: THREE.Mesh; life: number; maxLife: number }[]>([]);
  const decalsRef = useRef<THREE.Object3D[]>([]);
  const muzzleFlashRef = useRef<THREE.PointLight | null>(null);
  const recoilRef = useRef(0);
  const weaponGroundAvoidanceRef = useRef(0);
  const shotsFiredRef = useRef(0);
  const isShootPressedRef = useRef(false);
  const longPressTriggeredRef = useRef(false);
  const autoFireTimeoutRef = useRef<number | null>(null);
  const autoFireIntervalRef = useRef<number | null>(null);
  const grenadeThrowRequestedRef = useRef(false);
  const grenadeCooldownRef = useRef(0);
  const torchActiveRef = useRef(false);

  useEffect(() => { flightModeRef.current = flightMode; }, [flightMode]);
  useEffect(() => { cameraViewRef.current = cameraView; }, [cameraView]);
  useEffect(() => { fpsModeRef.current = fpsMode; }, [fpsMode]);

  // Auto-hide FPS instructions after 1.5 seconds
  useEffect(() => {
    if (showFpsInstructions) {
      const timer = setTimeout(() => setShowFpsInstructions(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showFpsInstructions]);

  // Keyboard listeners for flight
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
      if (fpsModeRef.current && e.code === 'KeyG' && !e.repeat) {
        grenadeThrowRequestedRef.current = true;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => { keysRef.current[e.code] = false; };
    const handleMouseMove = (e: MouseEvent) => {
      if (fpsModeRef.current) {
        const up = characterPosRef.current.lengthSq() > 0
          ? characterPosRef.current.clone().normalize()
          : new THREE.Vector3(0, 1, 0);
        const surfaceForward = getStableSurfaceDirection(up, fpsForwardRef.current);
        surfaceForward.applyAxisAngle(up, -e.movementX * 0.002).normalize();
        fpsForwardRef.current.copy(surfaceForward);
        fpsPitchRef.current -= e.movementY * 0.002;
        fpsPitchRef.current = THREE.MathUtils.clamp(fpsPitchRef.current, -Math.PI / 2.2, Math.PI / 2.2);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    
    // --- Camera Setup ---
    const aspect = window.innerWidth / window.innerHeight;
    
    // 1. Orthographic Camera (Planet/Third-Person)
    const frustumSizeOrtho = 18;
    const orthoCamera = new THREE.OrthographicCamera(
      frustumSizeOrtho * aspect / -2,
      frustumSizeOrtho * aspect / 2,
      frustumSizeOrtho / 2,
      frustumSizeOrtho / -2,
      0.1,
      1000
    );
    orthoCamera.position.set(0, 6, 18);
    orthoCameraRef.current = orthoCamera;

    // 2. Perspective Camera (FPS / Cockpit)
    const perspCamera = new THREE.PerspectiveCamera(75, aspect, 0.01, 1000);
    perspCameraRef.current = perspCamera;
    
    // Start with Ortho
    cameraRef.current = orthoCamera;

    // --- Weapon View-model (for FPS) ---
    const weaponGroup = new THREE.Group();
    weaponGroup.scale.set(0.27, 0.27, 0.27); // Slightly smaller so it stays clear of the ground line
    // Gun body
    const gunBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.12, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.8, roughness: 0.3 })
    );
    gunBody.position.set(0.2, -0.1, -0.25);
    weaponGroup.add(gunBody);
    
    // Barrel
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.1 })
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.2, -0.08, -0.4);
    weaponGroup.add(barrel);

    const makeOverlayStandardMaterial = (params: THREE.MeshStandardMaterialParameters) => {
      const material = new THREE.MeshStandardMaterial(params);
      material.depthTest = false;
      return material;
    };

    const torchGroup = new THREE.Group();
    torchGroup.position.set(-0.3, -0.32, -0.39);
    torchGroup.rotation.set(0.18, 0.08, 0.1);
    torchGroup.scale.setScalar(0.52);
    torchGroup.visible = false;

    const torchHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.02, 0.58, 10),
      makeOverlayStandardMaterial({ color: 0x6b4327, roughness: 0.96 })
    );
    torchHandle.rotation.z = -0.04;
    torchHandle.position.set(0.014, 0.06, 0);
    torchHandle.renderOrder = 28;
    torchGroup.add(torchHandle);

    const torchHeadWrap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.034, 0.03, 0.1, 10),
      makeOverlayStandardMaterial({ color: 0x28150d, roughness: 0.88, emissive: 0x120602, emissiveIntensity: 0.35 })
    );
    torchHeadWrap.position.set(0.014, 0.34, 0.002);
    torchHeadWrap.renderOrder = 29;
    torchGroup.add(torchHeadWrap);

    const torchCoalHead = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.03, 0.06, 10),
      makeOverlayStandardMaterial({ color: 0x15110f, roughness: 0.7, emissive: 0x2a1204, emissiveIntensity: 0.35 })
    );
    torchCoalHead.position.set(0.014, 0.39, 0.002);
    torchCoalHead.renderOrder = 30;
    torchGroup.add(torchCoalHead);

    const torchFlameCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xfff1c2,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    );
    torchFlameCore.position.set(0.014, 0.47, 0.006);
    torchFlameCore.renderOrder = 31;
    torchGroup.add(torchFlameCore);

    const torchFlameHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        color: 0xffa13d,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    );
    torchFlameHalo.position.set(0.014, 0.5, 0.006);
    torchFlameHalo.scale.set(0.12, 0.24, 1);
    torchFlameHalo.renderOrder = 31;
    torchGroup.add(torchFlameHalo);

    const buildParticleSprite = (innerColor: string, outerColor: string) => {
      const spriteCanvas = document.createElement('canvas');
      spriteCanvas.width = 128;
      spriteCanvas.height = 128;
      const spriteContext = spriteCanvas.getContext('2d');

      if (spriteContext) {
        const gradient = spriteContext.createRadialGradient(64, 64, 8, 64, 64, 64);
        gradient.addColorStop(0, innerColor);
        gradient.addColorStop(0.42, outerColor);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        spriteContext.fillStyle = gradient;
        spriteContext.fillRect(0, 0, 128, 128);
      }

      const spriteTexture = new THREE.CanvasTexture(spriteCanvas);
      spriteTexture.colorSpace = THREE.SRGBColorSpace;
      return spriteTexture;
    };

    const outerFlameSprite = buildParticleSprite('rgba(255, 210, 120, 1)', 'rgba(255, 94, 24, 0.94)');
    const innerFlameSprite = buildParticleSprite('rgba(255, 253, 240, 1)', 'rgba(255, 207, 104, 0.9)');
    const smokeSprite = buildParticleSprite('rgba(214, 214, 214, 0.5)', 'rgba(58, 58, 58, 0.16)');
    const torchFlameHaloMaterial = torchFlameHalo.material as THREE.SpriteMaterial;
    torchFlameHaloMaterial.map = outerFlameSprite;
    torchFlameHaloMaterial.alphaMap = outerFlameSprite;
    torchFlameHaloMaterial.needsUpdate = true;

    const outerFlameParticleCount = 96;
    const outerFlameSeeds = Float32Array.from({ length: outerFlameParticleCount }, () => Math.random());
    const outerFlamePositions = new Float32Array(outerFlameParticleCount * 3);
    const outerFlameColors = new Float32Array(outerFlameParticleCount * 3);
    const outerFlameGeometry = new THREE.BufferGeometry();
    outerFlameGeometry.setAttribute('position', new THREE.BufferAttribute(outerFlamePositions, 3));
    outerFlameGeometry.setAttribute('color', new THREE.BufferAttribute(outerFlameColors, 3));
    const outerFlameParticles = new THREE.Points(
      outerFlameGeometry,
      new THREE.PointsMaterial({
        size: 38,
        vertexColors: true,
        transparent: true,
        opacity: 0.76,
        map: outerFlameSprite,
        alphaMap: outerFlameSprite,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: false,
      })
    );
    outerFlameParticles.renderOrder = 32;
    outerFlameParticles.frustumCulled = false;
    torchGroup.add(outerFlameParticles);

    const innerFlameParticleCount = 44;
    const innerFlameSeeds = Float32Array.from({ length: innerFlameParticleCount }, () => Math.random());
    const innerFlamePositions = new Float32Array(innerFlameParticleCount * 3);
    const innerFlameColors = new Float32Array(innerFlameParticleCount * 3);
    const innerFlameGeometry = new THREE.BufferGeometry();
    innerFlameGeometry.setAttribute('position', new THREE.BufferAttribute(innerFlamePositions, 3));
    innerFlameGeometry.setAttribute('color', new THREE.BufferAttribute(innerFlameColors, 3));
    const innerFlameParticles = new THREE.Points(
      innerFlameGeometry,
      new THREE.PointsMaterial({
        size: 24,
        vertexColors: true,
        transparent: true,
        opacity: 0.86,
        map: innerFlameSprite,
        alphaMap: innerFlameSprite,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: false,
      })
    );
    innerFlameParticles.renderOrder = 33;
    innerFlameParticles.frustumCulled = false;
    torchGroup.add(innerFlameParticles);

    const smokeParticleCount = 28;
    const smokeSeeds = Float32Array.from({ length: smokeParticleCount }, () => Math.random());
    const smokePositions = new Float32Array(smokeParticleCount * 3);
    const smokeColors = new Float32Array(smokeParticleCount * 3);
    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute('position', new THREE.BufferAttribute(smokePositions, 3));
    smokeGeometry.setAttribute('color', new THREE.BufferAttribute(smokeColors, 3));
    const smokeParticles = new THREE.Points(
      smokeGeometry,
      new THREE.PointsMaterial({
        size: 40,
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        map: smokeSprite,
        alphaMap: smokeSprite,
        depthWrite: false,
        depthTest: false,
        sizeAttenuation: false,
      })
    );
    smokeParticles.renderOrder = 34;
    smokeParticles.frustumCulled = false;
    torchGroup.add(smokeParticles);

    const torchLight = new THREE.PointLight(0xffa34a, 0, 2.7, 2);
    torchLight.position.set(0.014, 0.46, 0.05);
    torchGroup.add(torchLight);
    perspCamera.add(torchGroup);
    
    scene.add(perspCamera); 
    perspCamera.add(weaponGroup);
    weaponGroupRef.current = weaponGroup;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const resAspect = width / height;

      // Update Ortho
      const fSize = 18;
      orthoCamera.left = fSize * resAspect / -2;
      orthoCamera.right = fSize * resAspect / 2;
      orthoCamera.top = fSize / 2;
      orthoCamera.bottom = fSize / -2;
      orthoCamera.updateProjectionMatrix();

      // Update Persp
      perspCamera.aspect = resAspect;
      perspCamera.updateProjectionMatrix();

      renderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    // --- Muzzle Flash Light ---
    const muzzleFlash = new THREE.PointLight(0xffaa33, 0, 2);
    perspCamera.add(muzzleFlash);
    muzzleFlash.position.set(0.06, -0.024, -0.15); // At barrel tip (scaled)
    muzzleFlashRef.current = muzzleFlash;

    // --- Shooting System ---
    const smokeMaterial = new THREE.MeshBasicMaterial({ 
      color: 0xaaaaaa, 
      transparent: true, 
      opacity: 0.6,
      depthWrite: false 
    });
    const smokeGeo = new THREE.SphereGeometry(0.015, 6, 6);
    const tracerGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.18, 6);
    tracerGeo.rotateX(Math.PI / 2);
    const tracerMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff0b3,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const grenadeGeo = new THREE.SphereGeometry(0.055, 10, 10);
    const grenadeMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b5563,
      roughness: 0.75,
      metalness: 0.2,
    });
    const grenadeBurstGeo = new THREE.SphereGeometry(0.16, 12, 12);
    const grenadeBurstMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb020,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });

    const decalOuterMaterial = new THREE.MeshStandardMaterial({
      color: 0xd1d5db,
      roughness: 1.0,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const decalInnerMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b5563,
      roughness: 1.0,
      metalness: 0,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
    });

    const spawnSmoke = (position: THREE.Vector3, count: number, spread: number, speed: number) => {
      for (let i = 0; i < count; i++) {
        const smokeMesh = new THREE.Mesh(smokeGeo, smokeMaterial.clone());
        smokeMesh.position.copy(position);
        const scale = 0.5 + Math.random() * 1.0;
        smokeMesh.scale.set(scale, scale, scale);
        scene.add(smokeMesh);

        const vel = new THREE.Vector3(
          (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * spread
        );
        // Bias upward (away from planet center) 
        const upDir = position.clone().normalize();
        vel.add(upDir.multiplyScalar(speed));

        smokeParticlesRef.current.push({
          mesh: smokeMesh,
          velocity: vel,
          life: 0,
          maxLife: 30 + Math.random() * 20
        });
      }
    };

    const getObstacleGap = (position: THREE.Vector3, radius: number) => {
      let nearestGap = Number.POSITIVE_INFINITY;

      for (const collider of obstacleCollidersRef.current) {
        const inverseMatrix = collider.object.matrixWorld.clone().invert();
        const localPoint = position.clone().applyMatrix4(inverseMatrix);

        for (const shape of collider.shapes) {
          if (shape.type === 'sphere') {
            const gap = localPoint.distanceTo(shape.center) - (shape.radius + radius);
            nearestGap = Math.min(nearestGap, gap);
            continue;
          }

          const expandedHalfSize = shape.halfSize.clone().addScalar(radius);
          const gap = getBoxSignedDistance(localPoint, shape.center, expandedHalfSize);
          nearestGap = Math.min(nearestGap, gap);
        }
      }

      return nearestGap;
    };

    const isObstacleBlocked = (position: THREE.Vector3, radius: number) => getObstacleGap(position, radius) < 0;

    const resolveObstacleCollisions = (position: THREE.Vector3, radius: number) => {
      const resolved = position.clone();

      for (const collider of obstacleCollidersRef.current) {
        const inverseMatrix = collider.object.matrixWorld.clone().invert();
        let localPoint = resolved.clone().applyMatrix4(inverseMatrix);

        for (const shape of collider.shapes) {
          if (shape.type === 'sphere') {
            const push = localPoint.clone().sub(shape.center);
            const minDistance = radius + shape.radius;
            const distanceSq = push.lengthSq();

            if (distanceSq >= minDistance * minDistance) continue;

            if (distanceSq < 1e-6) {
              push.set(0, 1, 0);
            } else {
              push.normalize();
            }

            localPoint.copy(shape.center).add(push.multiplyScalar(minDistance));
            continue;
          }

          const delta = localPoint.clone().sub(shape.center);
          const expandedHalfSize = shape.halfSize.clone().addScalar(radius);
          if (
            Math.abs(delta.x) > expandedHalfSize.x ||
            Math.abs(delta.y) > expandedHalfSize.y ||
            Math.abs(delta.z) > expandedHalfSize.z
          ) {
            continue;
          }

          const overlapX = expandedHalfSize.x - Math.abs(delta.x);
          const overlapY = expandedHalfSize.y - Math.abs(delta.y);
          const overlapZ = expandedHalfSize.z - Math.abs(delta.z);

          if (overlapX <= overlapY && overlapX <= overlapZ) {
            delta.x = (delta.x >= 0 ? 1 : -1) * expandedHalfSize.x;
          } else if (overlapY <= overlapX && overlapY <= overlapZ) {
            delta.y = (delta.y >= 0 ? 1 : -1) * expandedHalfSize.y;
          } else {
            delta.z = (delta.z >= 0 ? 1 : -1) * expandedHalfSize.z;
          }

          localPoint.copy(shape.center).add(delta);
        }

        resolved.copy(localPoint.applyMatrix4(collider.object.matrixWorld));
      }

      return resolved;
    };

    const triggerGrenadeBurst = (position: THREE.Vector3) => {
      const burst = new THREE.Mesh(grenadeBurstGeo, grenadeBurstMaterial.clone());
      burst.position.copy(position);
      scene.add(burst);
      grenadeBurstsRef.current.push({
        mesh: burst,
        life: 0,
        maxLife: 18,
      });

      spawnSmoke(position.clone(), 10, 0.05, 0.018);
      recoilRef.current = Math.max(recoilRef.current, 0.45);
    };

    const throwGrenade = () => {
      if (!fpsModeRef.current || !perspCameraRef.current || grenadeCooldownRef.current > 0) return;

      const cam = perspCameraRef.current;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
      const up = characterPosRef.current.clone().normalize();
      const grenade = new THREE.Mesh(grenadeGeo, grenadeMaterial.clone());

      grenade.position
        .copy(cam.position)
        .add(forward.clone().multiplyScalar(0.34))
        .add(right.clone().multiplyScalar(0.12))
        .add(up.clone().multiplyScalar(-0.05));
      scene.add(grenade);

      grenadesRef.current.push({
        mesh: grenade,
        velocity: forward.multiplyScalar(0.18).add(up.multiplyScalar(0.09)).add(characterVelocityRef.current.clone().multiplyScalar(0.6)),
        life: 0,
      });

      grenadeCooldownRef.current = GRENADE_THROW_COOLDOWN_FRAMES;
    };

    const clearAutoFire = () => {
      if (autoFireTimeoutRef.current !== null) {
        window.clearTimeout(autoFireTimeoutRef.current);
        autoFireTimeoutRef.current = null;
      }
      if (autoFireIntervalRef.current !== null) {
        window.clearInterval(autoFireIntervalRef.current);
        autoFireIntervalRef.current = null;
      }
      isShootPressedRef.current = false;
      longPressTriggeredRef.current = false;
    };

    const shoot = () => {
      if (!fpsModeRef.current || !perspCameraRef.current || !sceneRef.current) return;
      shotsFiredRef.current += 1;

      const cam = perspCameraRef.current;

      // Raycast from camera center
      raycasterRef.current.setFromCamera(new THREE.Vector2(0, 0), cam);
      
      // Get all meshes to test against (planet, houses, trees, etc.)
      const intersects = raycasterRef.current.intersectObjects(sceneRef.current.children, true);

      // Filter: only allow hits on objects tagged as shootable
      const hit = intersects.find(i => {
        let obj: THREE.Object3D | null = i.object;
        while (obj) {
          if (obj === weaponGroupRef.current) return false;
          if (obj === perspCameraRef.current) return false;
          if (obj.userData.shootable) return true;
          obj = obj.parent;
        }
        return false; // not tagged → ignore
      });

      // Muzzle flash
      if (muzzleFlashRef.current) {
        muzzleFlashRef.current.intensity = 3;
      }

      // Recoil
      recoilRef.current = 1.0;

      // Barrel smoke
      const fireOrigin = new THREE.Vector3().copy(cam.position);
      if (weaponGroupRef.current) {
        // Get barrel tip world position
        const barrelTip = new THREE.Vector3(0.2, -0.08, -0.4); // local barrel position
        barrelTip.multiplyScalar(0.3); // account for weapon group scale
        barrelTip.applyMatrix4(cam.matrixWorld);
        fireOrigin.copy(barrelTip);
        spawnSmoke(barrelTip, 3, 0.003, 0.002);
      }

      const targetPoint = hit?.point?.clone() ?? fireOrigin.clone().add(
        raycasterRef.current.ray.direction.clone().multiplyScalar(12)
      );
      const tracerDirection = targetPoint.clone().sub(fireOrigin).normalize();
      const tracerDistance = Math.max(0.25, fireOrigin.distanceTo(targetPoint));
      const tracerSpeed = 0.3;
      const tracer = new THREE.Mesh(tracerGeo, tracerMaterial.clone());
      tracer.position.copy(fireOrigin).add(tracerDirection.clone().multiplyScalar(0.16));
      tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tracerDirection);
      scene.add(tracer);
      bulletTracersRef.current.push({
        mesh: tracer,
        velocity: tracerDirection.multiplyScalar(tracerSpeed),
        life: 0,
        maxLife: Math.max(4, Math.ceil(tracerDistance / tracerSpeed)),
      });

      if (hit && hit.point && hit.face) {
        // --- Create Decal ---
        const decal = new THREE.Group();
        const outerCircle = new THREE.Mesh(
          new THREE.CircleGeometry(0.008, 18),
          decalOuterMaterial.clone()
        );
        const innerCircle = new THREE.Mesh(
          new THREE.CircleGeometry(0.0034, 16),
          decalInnerMaterial.clone()
        );
        innerCircle.position.z = 0.0005;
        decal.add(outerCircle, innerCircle);

        // Transform face normal from object-local to world space
        const worldNormal = hit.face.normal.clone();
        worldNormal.transformDirection(hit.object.matrixWorld);

        // Position at hit point, slightly offset along world normal
        decal.position.copy(hit.point).add(worldNormal.clone().multiplyScalar(0.002));

        // Orient to face outward along the world-space surface normal
        decal.lookAt(decal.position.clone().add(worldNormal));

        scene.add(decal);
        decalsRef.current.push(decal);

        // Limit decals to 50
        if (decalsRef.current.length > 50) {
          const old = decalsRef.current.shift()!;
          scene.remove(old);
          disposeSceneObject(old);
        }

        // Impact smoke
        spawnSmoke(hit.point.clone(), 5, 0.01, 0.005);
      }
    };

    const startAutoFire = () => {
      clearAutoFire();
      isShootPressedRef.current = true;
      autoFireTimeoutRef.current = window.setTimeout(() => {
        if (!isShootPressedRef.current || document.pointerLockElement !== renderer.domElement) return;
        longPressTriggeredRef.current = true;
        shoot();
        autoFireIntervalRef.current = window.setInterval(() => {
          if (!isShootPressedRef.current || document.pointerLockElement !== renderer.domElement) {
            clearAutoFire();
            return;
          }
          shoot();
        }, AUTO_FIRE_INTERVAL_MS);
      }, AUTO_FIRE_START_DELAY_MS);
    };

    const handleCanvasPointerDown = (event: PointerEvent) => {
      if (!fpsModeRef.current || event.button !== 0) return;
      if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
        return;
      }
      startAutoFire();
    };

    const handleShootRelease = () => {
      const shouldShootSingle =
        fpsModeRef.current &&
        isShootPressedRef.current &&
        !longPressTriggeredRef.current &&
        document.pointerLockElement === renderer.domElement;

      clearAutoFire();

      if (shouldShootSingle) {
        shoot();
      }
    };

    const handlePointerLockChange = () => {
      if (document.pointerLockElement !== renderer.domElement) {
        clearAutoFire();
      }
    };

    window.render_game_to_text = () => {
      const nearestObstacleGap = getObstacleGap(characterPosRef.current, PLAYER_COLLISION_RADIUS);

      return JSON.stringify({
      mode: fpsModeRef.current ? 'fps' : flightModeRef.current ? 'flight' : 'orbit',
      weather: weatherRef.current,
      cameraView: cameraViewRef.current,
      pointerLocked: document.pointerLockElement === renderer.domElement,
      autoFireActive: autoFireIntervalRef.current !== null,
      torchActive: torchActiveRef.current,
      shotsFired: shotsFiredRef.current,
      bulletTracers: bulletTracersRef.current.length,
      grenades: grenadesRef.current.length,
      grenadeBursts: grenadeBurstsRef.current.length,
      decals: decalsRef.current.length,
      smokeParticles: smokeParticlesRef.current.length,
      player: {
        x: Number(characterPosRef.current.x.toFixed(3)),
        y: Number(characterPosRef.current.y.toFixed(3)),
        z: Number(characterPosRef.current.z.toFixed(3)),
        speed: Number(characterVelocityRef.current.length().toFixed(3)),
        forwardX: Number(fpsForwardRef.current.x.toFixed(3)),
        forwardY: Number(fpsForwardRef.current.y.toFixed(3)),
        forwardZ: Number(fpsForwardRef.current.z.toFixed(3)),
        nearestObstacleGap: Number(nearestObstacleGap.toFixed(3)),
      },
    });
    };

    renderer.domElement.addEventListener('pointerdown', handleCanvasPointerDown);
    window.addEventListener('pointerup', handleShootRelease);
    window.addEventListener('pointercancel', handleShootRelease);
    document.addEventListener('pointerlockchange', handlePointerLockChange);

    // --- Controls ---
    const controls = new OrbitControls(orthoCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.rotateSpeed = 0.8;
    controls.minDistance = 7;
    controls.maxDistance = 25;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // --- Planet ---
    const planetGroup = new THREE.Group();
    scene.add(planetGroup);
    planetRef.current = planetGroup;

    // Texture Loading
    const textureLoader = new THREE.TextureLoader();
    const grassTexture = textureLoader.load('https://images.unsplash.com/photo-1550147760-44c9966d6bc7?auto=format&fit=crop&w=1024&q=80');
    grassTexture.wrapS = THREE.RepeatWrapping;
    grassTexture.wrapT = THREE.RepeatWrapping;
    grassTexture.repeat.set(8, 8); // Repeat for detail



    // Surface
    const geometry = new THREE.SphereGeometry(PLANET_RADIUS, 128, 128);
    const positions = geometry.attributes.position;
    const colors = [];
    const vertex = new THREE.Vector3();
    
    // Procedural Terrain Displacement & Coloring
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i);
      
      const displacement = getTerrainHeight(vertex);
      vertex.multiplyScalar(1 + displacement / PLANET_RADIUS);
      positions.setXYZ(i, vertex.x, vertex.y, vertex.z);

      // Height-based coloring
      const h = displacement;
      const color = new THREE.Color();
      if (h < -0.06) {
        color.setHex(0x1e3a8a); // Deep ocean
      } else if (h < -0.01) {
        color.setHex(0x3b82f6); // Shallow water
      } else if (h < 0.02) {
        color.setHex(0xfde68a); // Sand/Beach
      } else if (h < 0.18) {
        color.setHex(0x4ade80); // Grass/Plains
      } else if (h < 0.32) {
        color.setHex(0x166534); // Forest/Dark Green
      } else {
        color.setHex(0xffffff); // Snow peaks
      }
      colors.push(color.r, color.g, color.b);
    }
    
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ 
      vertexColors: true,
      roughness: 0.8,
      metalness: 0.1
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.receiveShadow = true;
    sphere.userData.shootable = true;
    planetGroup.add(sphere);

    // --- Water ---
    const waterGeo = new THREE.SphereGeometry(PLANET_RADIUS * WATER_LEVEL, 64, 64);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0ea5e9,
      transparent: true,
      opacity: 0.8,
      roughness: 0.1,
      metalness: 0.5
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    planetGroup.add(water);

    // --- Atmosphere Glow ---
    // Expanded radius so the airplane (radius Planet + 1.2 = 6.2) is fully inside but not too far out
    const atmosGeo = new THREE.SphereGeometry(PLANET_RADIUS * 1.3, 64, 64);
    
    // Direction the sun is located (for shader and later logic)
    const sunDir = new THREE.Vector3(10, 15, 10).normalize();

    const atmosMat = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: sunDir },
        atmosphereColor: { value: new THREE.Color(0x4aa6ff) },
        sunsetTint: { value: new THREE.Color(0xff8844) }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPositionNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          // Pass the raw normal for world-space calculations in fragment
          vPositionNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 sunDirection;
        uniform vec3 atmosphereColor;
        uniform vec3 sunsetTint;
        
        varying vec3 vNormal;
        varying vec3 vPositionNormal;
        
        void main() {
          // Calculate rim lighting (halo effect from outside)
          vec3 viewDirection = vec3(0.0, 0.0, 1.0);
          float rimDot = abs(dot(vNormal, viewDirection));
          float rimIntensity = pow(1.0 - rimDot, 3.0);
          
          // Calculate day/night transition
          float sunDot = dot(vPositionNormal, sunDirection);
          
          // Day side is bright (1.0), night side is dark (0.0)
          float dayFactor = smoothstep(-0.2, 0.5, sunDot);
          
          // Sunset/sunrise rim tinting
          float sunsetFactor = smoothstep(-0.2, 0.2, sunDot) - smoothstep(0.2, 0.6, sunDot);
          vec3 baseColor = mix(atmosphereColor, sunsetTint, sunsetFactor * 0.8);
          
          // Make the day sky brighter/whiter when looking straight down into the atmosphere
          float skyBrightness = dayFactor * rimDot;
          vec3 finalColor = mix(baseColor, vec3(0.8, 0.9, 1.0), skyBrightness * 0.4);
          
          // Opacity combines day sky thickness and edge halo
          float skyOpacity = dayFactor * 0.75; // Bright, solid day sky
          float haloOpacity = rimIntensity * (dayFactor * 0.8 + 0.2); // Outer glowing edge
          
          float finalOpacity = max(skyOpacity, haloOpacity);
          
          gl_FragColor = vec4(finalColor, finalOpacity);
        }
      `,
      transparent: true,
      blending: THREE.NormalBlending, // Normal blending hides stars behind the day sky
      side: THREE.BackSide, // BackSide helps create a rim-glow effect from the outside
      depthWrite: false
    });
    const atmosphere = new THREE.Mesh(atmosGeo, atmosMat);
    planetGroup.add(atmosphere);

    // --- Objects ---
    const windowMatNight = new THREE.MeshStandardMaterial({ 
      color: 0x111111,
      emissive: 0xffaa00,
      emissiveIntensity: 2 // Emit light on the dark side
    });
    const windowMatDay = new THREE.MeshStandardMaterial({ 
      color: 0x111111,
      emissive: 0xffaa00,
      emissiveIntensity: 0 // No light on the day side
    });
    houseWindowMaterialRef.current = windowMatNight; // For any backward compatibility check, though not strictly needed anymore

    // Variables already defined above: sunDir
    obstacleCollidersRef.current = [];

    const addTree = (pos: THREE.Vector3) => {
      // Adjust position to terrain height
      const direction = pos.clone().normalize();
      const displacement = getTerrainHeight(pos);
      const adjustedPos = direction.multiplyScalar(PLANET_RADIUS + displacement);

      // Skip trees in water or on snow
      if (adjustedPos.length() < PLANET_RADIUS * WATER_LEVEL + 0.02) return;
      if (displacement > 0.30) return; // No trees on snow peaks

      const tree = new THREE.Group();
      tree.userData.shootable = true;
      const trunkGeo = new THREE.CylinderGeometry(0.03, 0.05, 0.3);
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d2710 });
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 0.15;
      trunk.castShadow = true;
      tree.add(trunk);

      const leavesGeo = new THREE.SphereGeometry(0.2, 8, 8);
      const leavesMat = new THREE.MeshStandardMaterial({ color: 0x14532d });
      const leaves = new THREE.Mesh(leavesGeo, leavesMat);
      leaves.position.y = 0.4;
      leaves.castShadow = true;
      tree.add(leaves);

      tree.position.copy(adjustedPos);
      tree.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), adjustedPos.clone().normalize());
      planetGroup.add(tree);
      obstacleCollidersRef.current.push({
        object: tree,
        shapes: [
          { type: 'sphere', center: new THREE.Vector3(0, 0.17, 0), radius: 0.16 },
          { type: 'sphere', center: new THREE.Vector3(0, 0.4, 0), radius: 0.24 },
        ],
      });
    };

    const addHouse = (pos: THREE.Vector3) => {
      // Adjust position to terrain height
      const direction = pos.clone().normalize();
      const displacement = getTerrainHeight(pos);
      const adjustedPos = direction.multiplyScalar(PLANET_RADIUS + displacement);

      // Skip houses in water or on snow
      if (adjustedPos.length() < PLANET_RADIUS * WATER_LEVEL + 0.02) return;
      if (displacement > 0.28) return; // No houses on high peaks

      const house = new THREE.Group();
      house.userData.shootable = true;
      const baseGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
      const baseMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7 });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.15;
      base.castShadow = true;
      house.add(base);

      const roofGeo = new THREE.ConeGeometry(0.3, 0.25, 4);
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d });
      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.position.y = 0.4;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      house.add(roof);

      // Windows
      const windowGeo = new THREE.PlaneGeometry(0.08, 0.08);
      
      // Determine if house is on day or night side
      const isDaySide = direction.dot(sunDir) > -0.1; // Slightly offset to capture twilight
      const activeWindowMat = isDaySide ? windowMatDay : windowMatNight;

      for (let i = 0; i < 4; i++) {
        const windowMesh = new THREE.Mesh(windowGeo, activeWindowMat);
        const offset = 0.151;
        if (i === 0) {
          windowMesh.position.set(0, 0.15, offset);
        } else if (i === 1) {
          windowMesh.position.set(offset, 0.15, 0);
          windowMesh.rotation.y = Math.PI / 2;
        } else if (i === 2) {
          windowMesh.position.set(0, 0.15, -offset);
          windowMesh.rotation.y = Math.PI;
        } else if (i === 3) {
          windowMesh.position.set(-offset, 0.15, 0);
          windowMesh.rotation.y = -Math.PI / 2;
        }
        house.add(windowMesh);
      }

      house.position.copy(adjustedPos);
      house.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), adjustedPos.clone().normalize());
      planetGroup.add(house);
      obstacleCollidersRef.current.push({
        object: house,
        shapes: [
          { type: 'box', center: new THREE.Vector3(0, 0.15, 0), halfSize: new THREE.Vector3(0.18, 0.18, 0.18) },
          { type: 'sphere', center: new THREE.Vector3(0, 0.42, 0), radius: 0.27 },
        ],
      });
    };

    // Fibonacci Sphere placement for even distribution
    for (let i = 0; i < TREE_COUNT; i++) {
      const phi = Math.acos(-1 + (2 * i) / TREE_COUNT);
      const theta = Math.sqrt(TREE_COUNT * Math.PI) * phi;
      const pos = new THREE.Vector3().setFromSphericalCoords(PLANET_RADIUS, phi, theta);
      addTree(pos);
    }

    for (let i = 0; i < HOUSE_COUNT; i++) {
      const phi = Math.acos(-1 + (2 * (i + 0.5)) / HOUSE_COUNT);
      const theta = Math.sqrt(HOUSE_COUNT * Math.PI) * phi + 2.5;
      const pos = new THREE.Vector3().setFromSphericalCoords(PLANET_RADIUS, phi, theta);
      addHouse(pos);
    }

    // --- Clouds ---
    const cloudsGroup = new THREE.Group();
    scene.add(cloudsGroup);
    cloudsRef.current = cloudsGroup;

    const createCloud = (color: number, opacity: number, scale: number) => {
      const cloud = new THREE.Group();
      const cloudGeo = new THREE.SphereGeometry(0.3, 12, 12);
      const cloudMat = new THREE.MeshStandardMaterial({ 
        color, 
        transparent: true, 
        opacity 
      });
      
      const partCount = 3 + Math.floor(Math.random() * 4); // 3-6 parts
      for (let j = 0; j < partCount; j++) {
        const part = new THREE.Mesh(cloudGeo, cloudMat);
        part.position.x = (j - partCount / 2) * 0.22;
        part.position.y = Math.sin(j * 0.8) * 0.08;
        part.position.z = (Math.random() - 0.5) * 0.15;
        const s = (0.6 + Math.random() * 0.5) * scale;
        part.scale.set(s, s * 0.7, s);
        cloud.add(part);
      }
      return cloud;
    };

    const baseCloudPositions: THREE.Vector3[] = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const cloud = createCloud(0xffffff, 0.9, 1.0);
      // Restrict clouds to a narrow, realistic altitude band
      const radius = PLANET_RADIUS + 1.2 + Math.random() * 0.2;
      const phi = Math.random() * Math.PI;
      const theta = Math.random() * Math.PI * 2;
      cloud.position.setFromSphericalCoords(radius, phi, theta);
      cloud.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cloud.position.clone().normalize());
      cloudsGroup.add(cloud);
      baseCloudPositions.push(cloud.position.clone());
    }

    // --- Airplane ---
    const airplaneTilt = new THREE.Group();
    scene.add(airplaneTilt);
    airplaneTiltRef.current = airplaneTilt;

    const airplanePivot = new THREE.Group();
    airplaneTilt.add(airplanePivot);
    airplanePivotRef.current = airplanePivot;

    const airplane = new THREE.Group();
    airplane.userData.shootable = true;
    
    const fuselageGeo = new THREE.CylinderGeometry(0.06, 0.04, 0.5, 8);
    fuselageGeo.rotateX(Math.PI / 2);
    const fuselageMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
    airplane.add(fuselage);

    const cockpitGeo = new THREE.BoxGeometry(0.08, 0.06, 0.1);
    const cockpitMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.1, metalness: 0.8 });
    const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
    cockpit.position.set(0, 0.04, -0.15);
    airplane.add(cockpit);

    const wingGeo = new THREE.BoxGeometry(0.8, 0.02, 0.15);
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xef4444 });
    const wings = new THREE.Mesh(wingGeo, wingMat);
    wings.position.set(0, 0, -0.05);
    airplane.add(wings);

    const tailGeo = new THREE.BoxGeometry(0.25, 0.02, 0.1);
    const tail = new THREE.Mesh(tailGeo, wingMat);
    tail.position.set(0, 0, 0.2);
    airplane.add(tail);

    const finGeo = new THREE.BoxGeometry(0.02, 0.15, 0.1);
    const fin = new THREE.Mesh(finGeo, wingMat);
    fin.position.set(0, 0.075, 0.2);
    airplane.add(fin);

    const propGeo = new THREE.BoxGeometry(0.3, 0.02, 0.02);
    const propMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const propeller = new THREE.Mesh(propGeo, propMat);
    propeller.position.set(0, 0, -0.26);
    propeller.name = "propeller";
    airplane.add(propeller);

    airplane.position.set(PLANET_RADIUS + 1.5, 0, 0);
    airplane.rotation.z = -Math.PI / 2;
    airplanePivot.add(airplane);

    // --- Birds ---
    const birdPivots: THREE.Group[] = [];
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    
    for (let i = 0; i < 5; i++) {
      const flockTilt = new THREE.Group();
      flockTilt.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      scene.add(flockTilt);
      
      const flockPivot = new THREE.Group();
      flockTilt.add(flockPivot);
      birdPivots.push(flockPivot);

      const numBirds = 3 + Math.floor(Math.random() * 4);
      for (let j = 0; j < numBirds; j++) {
        const bird = new THREE.Group();
        
        const bWingGeo = new THREE.BoxGeometry(0.06, 0.01, 0.02);
        
        const leftWing = new THREE.Mesh(bWingGeo, birdMat);
        leftWing.position.set(-0.025, 0, 0);
        leftWing.rotation.y = Math.PI / 4;
        leftWing.name = "lw";
        
        const rightWing = new THREE.Mesh(bWingGeo, birdMat);
        rightWing.position.set(0.025, 0, 0);
        rightWing.rotation.y = -Math.PI / 4;
        rightWing.name = "rw";
        
        bird.add(leftWing, rightWing);
        
        const radius = PLANET_RADIUS + 0.3 + Math.random() * 0.4;
        bird.position.set(radius, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8);
        bird.rotation.z = -Math.PI / 2;
        
        flockPivot.add(bird);
      }
    }
    birdPivotsRef.current = birdPivots;

    // --- Celestial Bodies & Lights ---
    // Create a group that we can rotate for the day/night cycle
    const celestialGroup = new THREE.Group();
    scene.add(celestialGroup);
    celestialGroupRef.current = celestialGroup;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.05); // Very dim ambient moonlight
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;

    // Sun target position
    const lightDistance = 40;
    const sunPos = new THREE.Vector3(10, 15, 10).normalize().multiplyScalar(lightDistance);

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.5); // Much brighter sun for stark contrast
    sunLight.position.copy(sunPos);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    celestialGroup.add(sunLight);
    sunLightRef.current = sunLight;

    // Visual Sun Mesh
    const sunGeo = new THREE.SphereGeometry(2, 32, 32);
    const sunMat = new THREE.MeshBasicMaterial({ 
      color: 0xffffee,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.copy(sunPos);
    
    // Core of the sun (brighter)
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    sunMesh.add(sunCore);
    celestialGroup.add(sunMesh);

    // Visual Moon Mesh (opposite the sun)
    const moonPos = sunPos.clone().multiplyScalar(-1);
    const moonGeo = new THREE.SphereGeometry(1.4, 32, 32);
    const moonMat = new THREE.MeshStandardMaterial({
      color: 0xdddddd,
      roughness: 0.8,
      metalness: 0.1,
      emissive: 0x444455,
      emissiveIntensity: 0.4
    });
    const moonMesh = new THREE.Mesh(moonGeo, moonMat);
    moonMesh.position.copy(moonPos);
    celestialGroup.add(moonMesh);

    // Set a static rotation or let celestialGroup stay at default
    // We remove dynamic day/night rotation since the planet itself has a light and dark side now
    celestialGroup.rotation.y = 0;

    // --- Starfield ---
    const starGeometry = new THREE.BufferGeometry();
    const starCount = 15000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      // Create stars within the orthographic view bounds
      const r = 40 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[i] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i + 2] = r * Math.cos(phi);
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.5, // Fixed pixel size on screen for orthographic projection
      sizeAttenuation: false, // Orthographic camera doesn't use distance for sizing
      transparent: true,
      opacity: 0.5, // Static opacity
    });
    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);
    starfieldRef.current = starField;

    // --- Animation Loop ---
    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      
      // Only rotate the planet automatically if not in flight mode or FPS mode
      if (isRotatingRef.current && planetRef.current && !flightModeRef.current && !fpsModeRef.current) {
        planetRef.current.rotation.y += 0.003;
        cloudsRef.current!.rotation.y += 0.0004;
      }

      // ============================================
      // 1. AIRPLANE ANIMATION (always runs independently)
      // ============================================
      if (airplanePivotRef.current && airplaneTiltRef.current) {
        if (!flightModeRef.current && !fpsModeRef.current) {
          // Auto-orbit mode: keep flying forward naturally
          airplanePivotRef.current.rotateY(0.008);
          const airplane = airplanePivotRef.current.children[0];
          if (airplane) {
            airplane.rotation.z = THREE.MathUtils.lerp(airplane.rotation.z, -Math.PI / 2, 0.05);
          }
          airplanePivotRef.current.quaternion.normalize();
        } else if (flightModeRef.current) {
          // Manual Flight mode
          const keys = keysRef.current;
          const airplane = airplanePivotRef.current.children[0];

          if (keys['KeyW'] || keys['ArrowUp']) planeSpeedRef.current += 0.0005;
          else if (keys['KeyS'] || keys['ArrowDown']) planeSpeedRef.current -= 0.0005;
          else planeSpeedRef.current *= 0.98;
          
          planeSpeedRef.current = THREE.MathUtils.clamp(planeSpeedRef.current, -0.015, 0.025);

          let targetRoll = -Math.PI / 2;
          if (keys['KeyA'] || keys['ArrowLeft']) {
            airplanePivotRef.current.rotateX(0.04);
            targetRoll = -Math.PI / 2 + 0.6;
          } else if (keys['KeyD'] || keys['ArrowRight']) {
            airplanePivotRef.current.rotateX(-0.04);
            targetRoll = -Math.PI / 2 - 0.6;
          }

          if (airplane) {
            airplane.rotation.z = THREE.MathUtils.lerp(airplane.rotation.z, targetRoll, 0.1);
          }

          airplanePivotRef.current.rotateY(planeSpeedRef.current);
          airplanePivotRef.current.quaternion.normalize();
        }
        
        // Propeller animation (always)
        const airplane = airplanePivotRef.current.children[0];
        if (airplane) {
          const prop = airplane.getObjectByName("propeller");
          if (prop) prop.rotation.z += 0.3;
        }
      }

      // ============================================
      // 2. CAMERA LOGIC (priority: FPS > Flight > Orbit)
      // ============================================
      const currentMode: 'orbit' | 'flight' | 'fps' = fpsModeRef.current
        ? 'fps'
        : flightModeRef.current
          ? 'flight'
          : 'orbit';
      if (currentMode === 'orbit' && activeModeRef.current !== 'orbit') {
        shouldResetOrbitCameraRef.current = true;
      }
      activeModeRef.current = currentMode;

      if (fpsModeRef.current) {
        // --- FPS MODE ---
        cameraRef.current = perspCameraRef.current;
        if (!cameraRef.current) return;

        controls.enabled = false;

        const keys = keysRef.current;
        const up = characterPosRef.current.clone().normalize();
        const surfaceForward = getStableSurfaceDirection(up, fpsForwardRef.current);
        fpsForwardRef.current.copy(surfaceForward);
        const surfaceRight = new THREE.Vector3().crossVectors(surfaceForward, up).normalize();

        // Gravity
        const gravityForce = 0.006;
        const jumpImpulse = 0.15;
        characterVelocityRef.current.add(up.clone().multiplyScalar(-gravityForce));

        // Movement
        const moveDir = new THREE.Vector3();
        if (keys['KeyW'] || keys['ArrowUp']) moveDir.add(surfaceForward);
        if (keys['KeyS'] || keys['ArrowDown']) moveDir.sub(surfaceForward);
        if (keys['KeyA'] || keys['ArrowLeft']) moveDir.sub(surfaceRight);
        if (keys['KeyD'] || keys['ArrowRight']) moveDir.add(surfaceRight);
        
        let weaponBaseY = -0.028;
        let weaponBaseX = 0.1;

        if (moveDir.lengthSq() > 0) {
          moveDir.normalize().multiplyScalar(0.08);
          characterPosRef.current.copy(
            resolveObstacleCollisions(
              characterPosRef.current.clone().add(moveDir),
              PLAYER_COLLISION_RADIUS
            )
          );
          
          // Weapon walk sway
          if (weaponGroupRef.current) {
            const time = Date.now() * 0.008;
            weaponBaseY += Math.sin(time) * 0.003;
            weaponBaseX += Math.cos(time * 0.5) * 0.003;
          }
        } else {
          // Idle sway
          if (weaponGroupRef.current) {
            const time = Date.now() * 0.002;
            weaponBaseY += Math.sin(time) * 0.001;
          }
        }

        // Apply velocity (gravity/jump)
        characterPosRef.current.add(characterVelocityRef.current);

        // Ground collision
        const currentUp = characterPosRef.current.clone().normalize();
        const unitPos = currentUp.clone();
        const terrainH = getTerrainHeight(currentUp);
        const distFromCenter = characterPosRef.current.length();
        const targetRadius = PLANET_RADIUS + terrainH + 0.15;
        
        if (distFromCenter < targetRadius) {
          characterPosRef.current.setLength(targetRadius);
          
          if (characterVelocityRef.current.dot(currentUp) < 0) {
            characterVelocityRef.current.set(0, 0, 0);
          }

          if (keys['Space']) {
            characterVelocityRef.current.add(currentUp.clone().multiplyScalar(jumpImpulse));
          }
        }

        characterPosRef.current.copy(
          resolveObstacleCollisions(characterPosRef.current, PLAYER_COLLISION_RADIUS)
        );
        const obstacleResolvedUp = characterPosRef.current.clone().normalize();
        const obstacleResolvedTerrain = getTerrainHeight(obstacleResolvedUp);
        const obstacleResolvedRadius = PLANET_RADIUS + obstacleResolvedTerrain + 0.15;
        if (characterPosRef.current.length() < obstacleResolvedRadius) {
          characterPosRef.current.setLength(obstacleResolvedRadius);
        }

        // Camera at eye level
        if (weaponGroupRef.current) weaponGroupRef.current.visible = true;
        cameraRef.current.position.copy(characterPosRef.current);
        
        // Orientation: stable tangent heading + local pitch
        const groundedUp = characterPosRef.current.clone().normalize();
        const groundedForward = getStableSurfaceDirection(groundedUp, fpsForwardRef.current);
        fpsForwardRef.current.copy(groundedForward);
        const groundedRight = new THREE.Vector3().crossVectors(groundedForward, groundedUp).normalize();
        const lookDirection = groundedForward.clone().applyAxisAngle(groundedRight, fpsPitchRef.current).normalize();
        cameraRef.current.up.copy(groundedUp);
        cameraRef.current.lookAt(cameraRef.current.position.clone().add(lookDirection));
        characterQuatRef.current.copy(cameraRef.current.quaternion);

        const lookDownFactor = THREE.MathUtils.smoothstep(-lookDirection.dot(groundedUp), 0.1, 0.95);
        weaponGroundAvoidanceRef.current = lookDownFactor;
        if (weaponGroupRef.current) {
          weaponGroupRef.current.position.x = weaponBaseX;
          weaponGroupRef.current.position.y = weaponBaseY + lookDownFactor * 0.004;
          weaponGroupRef.current.position.z = lookDownFactor * 0.0015;
        }

        const isNightSide = groundedUp.dot(sunDir) < -0.08;
        torchActiveRef.current = isNightSide;
        torchGroup.visible = isNightSide;
        if (isNightSide) {
          const torchTime = performance.now() * 0.0035;
          const flicker = 0.92 + Math.sin(torchTime * 8.1) * 0.1 + Math.sin(torchTime * 14.4) * 0.05;
          const flameLean = Math.sin(torchTime * 1.8) * 0.014;
          const torchLookLift = lookDownFactor * 0.18;
          const torchLookPull = lookDownFactor * 0.03;
          const torchCounterTilt = lookDownFactor * 0.28;

          torchFlameCore.scale.set(0.46 + flicker * 0.1, 0.86 + flicker * 0.22, 0.46 + flicker * 0.1);
          (torchFlameCore.material as THREE.MeshBasicMaterial).opacity = 0.24 + flicker * 0.12;
          torchFlameHalo.scale.set(0.16 + flicker * 0.035, 0.34 + flicker * 0.08, 1);
          (torchFlameHalo.material as THREE.SpriteMaterial).opacity = 0.2 + flicker * 0.07;
          torchLight.intensity = 1.35 + flicker * 0.68;
          torchLight.distance = 2.55 + flicker * 0.28;
          torchLight.position.set(
            0.014,
            0.46 + lookDownFactor * 0.12,
            0.05 - lookDownFactor * 0.01
          );
          torchGroup.position.set(
            -0.3 + Math.cos(torchTime * 1.05) * 0.004,
            -0.3 + torchLookLift + Math.sin(torchTime * 1.2) * 0.004,
            -0.39 + torchLookPull + Math.sin(torchTime * 0.9) * 0.006
          );
          torchGroup.rotation.set(
            0.18 - torchCounterTilt + Math.sin(torchTime * 1.2) * 0.01,
            0.08 + Math.cos(torchTime * 1.35) * 0.01,
            0.1 - lookDownFactor * 0.03 + Math.sin(torchTime * 1.05) * 0.012
          );

          for (let index = 0; index < outerFlameParticleCount; index += 1) {
            const particleIndex = index * 3;
            const phase = torchTime * 0.88 + index * 0.17;
            const life = phase % 1;
            const seed = outerFlameSeeds[index];
            const radius = (0.036 + seed * 0.018) * (1 - life) + 0.01;
            outerFlamePositions[particleIndex] =
              0.014
              + flameLean * life * (1.35 + seed * 0.8)
              + Math.sin(phase * (7.6 + seed * 4.2) + seed * Math.PI * 2) * radius * 0.62;
            outerFlamePositions[particleIndex + 1] = 0.38 + life * (0.22 + seed * 0.12);
            outerFlamePositions[particleIndex + 2] =
              0.004 + Math.cos(phase * (5.1 + seed * 2.8) + seed * 3.4) * radius * 0.18;

            outerFlameColors[particleIndex] = 1;
            outerFlameColors[particleIndex + 1] = 0.52 + (1 - life) * 0.34;
            outerFlameColors[particleIndex + 2] = 0.05 + (1 - life) * 0.1;
          }

          for (let index = 0; index < innerFlameParticleCount; index += 1) {
            const particleIndex = index * 3;
            const phase = torchTime * 1.1 + index * 0.27;
            const life = phase % 1;
            const seed = innerFlameSeeds[index];
            const radius = (0.015 + seed * 0.01) * (1 - life) + 0.004;
            innerFlamePositions[particleIndex] =
              0.014
              + flameLean * life * (0.9 + seed * 0.35)
              + Math.sin(phase * (8.4 + seed * 5.1) + seed * 5.6) * radius * 0.48;
            innerFlamePositions[particleIndex + 1] = 0.41 + life * (0.18 + seed * 0.08);
            innerFlamePositions[particleIndex + 2] =
              0.006 + Math.cos(phase * (6.2 + seed * 2.7) + seed * 2.4) * radius * 0.12;

            innerFlameColors[particleIndex] = 1;
            innerFlameColors[particleIndex + 1] = 0.92 - life * 0.1;
            innerFlameColors[particleIndex + 2] = 0.46 - life * 0.24;
          }

          for (let index = 0; index < smokeParticleCount; index += 1) {
            const particleIndex = index * 3;
            const phase = torchTime * 0.3 + index * 0.22;
            const life = phase % 1;
            const seed = smokeSeeds[index];
            const drift = 0.018 + life * (0.04 + seed * 0.03);
            smokePositions[particleIndex] =
              0.014
              + flameLean * life * (2.2 + seed)
              + Math.sin(phase * (4.1 + seed * 1.8) + seed * 4.7) * drift * 0.9;
            smokePositions[particleIndex + 1] = 0.58 + life * (0.18 + seed * 0.12);
            smokePositions[particleIndex + 2] =
              0.01 + Math.cos(phase * (3.2 + seed * 1.4) + seed * 3.9) * drift * 0.2;

            const smokeShade = 0.24 + (1 - life) * 0.22;
            smokeColors[particleIndex] = smokeShade;
            smokeColors[particleIndex + 1] = smokeShade * 0.92;
            smokeColors[particleIndex + 2] = smokeShade * 0.88;
          }

          (outerFlameGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          (outerFlameGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
          (innerFlameGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          (innerFlameGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
          (smokeGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          (smokeGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        } else {
          torchLight.intensity = 0;
          torchFlameCore.scale.setScalar(0.45);
          (torchFlameCore.material as THREE.MeshBasicMaterial).opacity = 0.12;
          (torchFlameHalo.material as THREE.SpriteMaterial).opacity = 0.08;
        }

        if (grenadeCooldownRef.current > 0) {
          grenadeCooldownRef.current -= 1;
        }
        if (grenadeThrowRequestedRef.current) {
          throwGrenade();
          grenadeThrowRequestedRef.current = false;
        }

      } else if (flightModeRef.current) {
        // --- FLIGHT MODE CAMERA ---
        controls.enabled = false;
        weaponGroundAvoidanceRef.current = 0;
        torchActiveRef.current = false;
        torchGroup.visible = false;
        torchLight.intensity = 0;

        if (cameraViewRef.current === 'cockpit') {
          cameraRef.current = perspCameraRef.current;
        } else {
          cameraRef.current = orthoCameraRef.current;
        }
        if (!cameraRef.current) return;

        const airplane = airplanePivotRef.current?.children[0];
        if (airplane) {
          const planeWorldPos = new THREE.Vector3();
          airplane.getWorldPosition(planeWorldPos);
          
          const planeWorldQuat = new THREE.Quaternion();
          airplane.getWorldQuaternion(planeWorldQuat);

          const upVector = planeWorldPos.clone().normalize();
          const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(planeWorldQuat).normalize();

          cameraRef.current.up.copy(upVector);

          if (cameraViewRef.current === 'third-person') {
            const ortho = cameraRef.current as THREE.OrthographicCamera;
            ortho.zoom = THREE.MathUtils.lerp(ortho.zoom, 2.5, 0.05);
            ortho.updateProjectionMatrix();

            const offset = forwardVector.clone().multiplyScalar(-6).add(upVector.clone().multiplyScalar(4));
            const targetCamPos = planeWorldPos.clone().add(offset);
            cameraRef.current.position.lerp(targetCamPos, 0.1);
            cameraRef.current.lookAt(planeWorldPos);
          } else if (cameraViewRef.current === 'cockpit') {
            const offset = forwardVector.clone().multiplyScalar(0.4).add(upVector.clone().multiplyScalar(0.2));
            cameraRef.current.position.copy(planeWorldPos).add(offset);
            
            const lookAtTarget = cameraRef.current.position.clone().add(forwardVector.clone().multiplyScalar(10));
            cameraRef.current.lookAt(lookAtTarget);
          }
        }

        if (weaponGroupRef.current) weaponGroupRef.current.visible = false;

      } else {
        // --- ORBIT MODE (default) ---
        cameraRef.current = orthoCameraRef.current;
        if (!cameraRef.current) return;
        const ortho = cameraRef.current as THREE.OrthographicCamera;
        weaponGroundAvoidanceRef.current = 0;
        torchActiveRef.current = false;
        torchGroup.visible = false;
        torchLight.intensity = 0;

        // Reset zoom smoothly
        if (ortho.zoom !== 1.0) {
          ortho.zoom = THREE.MathUtils.lerp(ortho.zoom, 1.0, 0.05);
          if (Math.abs(ortho.zoom - 1.0) < 0.01) ortho.zoom = 1.0;
          ortho.updateProjectionMatrix();
        }

        controls.enabled = true;

        if (shouldResetOrbitCameraRef.current) {
          const initialPos = new THREE.Vector3(0, 6, 18);
          const worldUp = new THREE.Vector3(0, 1, 0);
          cameraRef.current.position.lerp(initialPos, 0.12);
          cameraRef.current.up.lerp(worldUp, 0.12);
          controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.12);

          if (
            cameraRef.current.position.distanceToSquared(initialPos) < 0.0025 &&
            cameraRef.current.up.distanceToSquared(worldUp) < 0.0004 &&
            controls.target.lengthSq() < 0.0025
          ) {
            cameraRef.current.position.copy(initialPos);
            cameraRef.current.up.copy(worldUp);
            controls.target.set(0, 0, 0);
            shouldResetOrbitCameraRef.current = false;
          }
        }

        controls.update();

        // Hide weapon
        if (weaponGroupRef.current) weaponGroupRef.current.visible = false;
      }

      // Clouds drift (always, very slow)
      if (cloudsRef.current && !fpsModeRef.current) {
        cloudsRef.current.rotation.y += 0.0004;
      }
      
      if (birdPivotsRef.current) {
        const time = Date.now() * 0.01;
        birdPivotsRef.current.forEach((pivot, index) => {
          pivot.rotation.y += 0.004 + index * 0.0005;
          if (pivot.parent) {
            pivot.parent.rotation.x += 0.0002;
          }
          
          pivot.children.forEach((bird, bIndex) => {
            const lw = bird.getObjectByName("lw");
            const rw = bird.getObjectByName("rw");
            if (lw && rw) {
              const flap = Math.sin(time * 1.5 + bIndex) * 0.4;
              lw.rotation.z = flap;
              rw.rotation.z = -flap;
            }
          });
        });
      }

      // (Disabled starfield rotation per user request)

      // Weather animation - each particle is bound to its parent cloud
      if (weatherParticlesRef.current && cloudsRef.current) {
        const w = weatherRef.current;
        const positions = weatherParticlesRef.current.geometry.attributes.position.array as Float32Array;
        const cloudMap = particleCloudMapRef.current;
        const fallProgress = particleFallProgressRef.current;
        const clouds = cloudsRef.current.children;
        const cloudWorldPos = new THREE.Vector3();
        const surfaceRadius = PLANET_RADIUS + 0.15;

        if (w === 'windy') {
          // Windy: simple horizontal movement
          for (let i = 0; i < positions.length; i += 3) {
            positions[i] += 0.8;
            positions[i + 1] += Math.sin(Date.now() * 0.002 + i) * 0.1;
            if (positions[i] > 25) positions[i] = -25;
          }
        } else if (cloudMap.length > 0 && fallProgress.length > 0) {
          // Rain/Snow: particles track their parent cloud
          const fallSpeed = w === 'rain' ? 0.004 : 0.0015;
          const particleCount = cloudMap.length;

          for (let pi = 0; pi < particleCount; pi++) {
            const ci = cloudMap[pi];
            if (ci < 0 || ci >= clouds.length) continue;

            // Get this cloud's current world position (accounts for rotation)
            clouds[ci].getWorldPosition(cloudWorldPos);
            const cloudDist = cloudWorldPos.length();
            const dir = cloudWorldPos.clone().normalize();

            // Advance fall progress
            fallProgress[pi] += fallSpeed + Math.random() * fallSpeed * 0.5;
            if (fallProgress[pi] >= 1.0) {
              fallProgress[pi] = Math.random() * 0.05; // reset to top of cloud
            }

            // Interpolate: cloud position → surface along inward direction
            const t = fallProgress[pi];
            const currentRadius = cloudDist * (1 - t) + surfaceRadius * t;

            // Read pre-generated random lateral offsets for this particle
            const offsets = particleOffsetRef.current;
            const lateralX = offsets[pi * 2];
            const lateralZ = offsets[pi * 2 + 1];

            // Find perpendicular vectors to the inward direction
            const perp1 = new THREE.Vector3(-dir.z, 0, dir.x);
            if (perp1.lengthSq() < 0.001) perp1.set(0, 0, 1);
            perp1.normalize();
            const perp2 = new THREE.Vector3().crossVectors(dir, perp1).normalize();

            // Snow: slight additional swirl during fall
            let swirlX = 0, swirlZ = 0;
            if (w === 'snow') {
              const seed = pi * 3.7;
              swirlX = Math.sin(Date.now() * 0.0005 + seed) * 0.08 * t;
              swirlZ = Math.cos(Date.now() * 0.0004 + seed * 1.3) * 0.08 * t;
            }

            const px = dir.x * currentRadius + perp1.x * (lateralX + swirlX) + perp2.x * (lateralZ + swirlZ);
            const py = dir.y * currentRadius + perp1.y * (lateralX + swirlX) + perp2.y * (lateralZ + swirlZ);
            const pz = dir.z * currentRadius + perp1.z * (lateralX + swirlX) + perp2.z * (lateralZ + swirlZ);

            positions[pi * 3] = px;
            positions[pi * 3 + 1] = py;
            positions[pi * 3 + 2] = pz;
          }
        }
        weatherParticlesRef.current.geometry.attributes.position.needsUpdate = true;
      }

      // --- Shooting Effects Update ---
      // Smoke particles
      for (let i = smokeParticlesRef.current.length - 1; i >= 0; i--) {
        const p = smokeParticlesRef.current[i];
        p.life++;
        p.mesh.position.add(p.velocity);
        p.velocity.multiplyScalar(0.94); // Drag
        
        // Expand and fade
        const t = p.life / p.maxLife;
        const scale = (0.5 + t * 2.0);
        p.mesh.scale.set(scale, scale, scale);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - t);

        if (p.life >= p.maxLife) {
          scene.remove(p.mesh);
          p.mesh.geometry.dispose();
          (p.mesh.material as THREE.Material).dispose();
          smokeParticlesRef.current.splice(i, 1);
        }
      }

      // Bullet tracers
      for (let i = bulletTracersRef.current.length - 1; i >= 0; i--) {
        const tracer = bulletTracersRef.current[i];
        tracer.life++;
        tracer.mesh.position.add(tracer.velocity);

        const t = tracer.life / tracer.maxLife;
        tracer.mesh.scale.set(1, 1, 1 + t * 0.6);
        (tracer.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);

        if (tracer.life >= tracer.maxLife) {
          scene.remove(tracer.mesh);
          tracer.mesh.geometry.dispose();
          (tracer.mesh.material as THREE.Material).dispose();
          bulletTracersRef.current.splice(i, 1);
        }
      }

      // Grenades
      for (let i = grenadesRef.current.length - 1; i >= 0; i--) {
        const grenade = grenadesRef.current[i];
        grenade.life++;

        const grenadeUp = grenade.mesh.position.clone().normalize();
        grenade.velocity.add(grenadeUp.multiplyScalar(-0.0045));
        grenade.mesh.position.add(grenade.velocity);
        grenade.mesh.rotation.x += 0.18;
        grenade.mesh.rotation.z += 0.24;

        const surfaceUp = grenade.mesh.position.clone().normalize();
        const surfaceRadius = PLANET_RADIUS + getTerrainHeight(surfaceUp) + 0.05;
        const groundHit = grenade.mesh.position.length() <= surfaceRadius;
        const obstacleHit = isObstacleBlocked(grenade.mesh.position, 0.07);

        if (groundHit) {
          grenade.mesh.position.setLength(surfaceRadius);
        }

        if ((grenade.life > GRENADE_ARM_FRAMES && (groundHit || obstacleHit)) || grenade.life >= GRENADE_FUSE_FRAMES) {
          triggerGrenadeBurst(grenade.mesh.position.clone());
          scene.remove(grenade.mesh);
          grenade.mesh.geometry.dispose();
          (grenade.mesh.material as THREE.Material).dispose();
          grenadesRef.current.splice(i, 1);
          continue;
        }

        if (groundHit) {
          const normal = grenade.mesh.position.clone().normalize();
          const verticalVelocity = grenade.velocity.dot(normal);
          if (verticalVelocity < 0) {
            grenade.velocity.addScaledVector(normal, -1.55 * verticalVelocity);
            grenade.velocity.multiplyScalar(0.72);
          }
        }
      }

      // Grenade explosion bursts
      for (let i = grenadeBurstsRef.current.length - 1; i >= 0; i--) {
        const burst = grenadeBurstsRef.current[i];
        burst.life++;
        const t = burst.life / burst.maxLife;
        const scale = 1 + t * 4.5;
        burst.mesh.scale.set(scale, scale, scale);
        (burst.mesh.material as THREE.MeshBasicMaterial).opacity = 0.78 * (1 - t);

        if (burst.life >= burst.maxLife) {
          scene.remove(burst.mesh);
          burst.mesh.geometry.dispose();
          (burst.mesh.material as THREE.Material).dispose();
          grenadeBurstsRef.current.splice(i, 1);
        }
      }

      // Muzzle flash decay
      if (muzzleFlashRef.current && muzzleFlashRef.current.intensity > 0) {
        muzzleFlashRef.current.intensity *= 0.7;
        if (muzzleFlashRef.current.intensity < 0.05) muzzleFlashRef.current.intensity = 0;
      }

      // Weapon recoil recovery
      if (recoilRef.current > 0.01 && weaponGroupRef.current) {
        recoilRef.current *= 0.85;
        weaponGroupRef.current.rotation.x = weaponGroundAvoidanceRef.current * 0.5 - recoilRef.current * 0.15;
      } else if (weaponGroupRef.current) {
        weaponGroupRef.current.rotation.x = weaponGroundAvoidanceRef.current * 0.5;
        recoilRef.current = 0;
      }

      if (cameraRef.current) {
        renderer.render(scene, cameraRef.current);
      }
    };
    animate();



    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('pointerdown', handleCanvasPointerDown);
      window.removeEventListener('pointerup', handleShootRelease);
      window.removeEventListener('pointercancel', handleShootRelease);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      cancelAnimationFrame(frameId);
      clearAutoFire();
      delete window.render_game_to_text;
      
      // Clean up shooting effects
      smokeParticlesRef.current.forEach(p => {
        scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      });
      smokeParticlesRef.current = [];
      bulletTracersRef.current.forEach(tracer => {
        scene.remove(tracer.mesh);
        tracer.mesh.geometry.dispose();
        (tracer.mesh.material as THREE.Material).dispose();
      });
      bulletTracersRef.current = [];
      grenadesRef.current.forEach(grenade => {
        scene.remove(grenade.mesh);
        grenade.mesh.geometry.dispose();
        (grenade.mesh.material as THREE.Material).dispose();
      });
      grenadesRef.current = [];
      grenadeBurstsRef.current.forEach(burst => {
        scene.remove(burst.mesh);
        burst.mesh.geometry.dispose();
        (burst.mesh.material as THREE.Material).dispose();
      });
      grenadeBurstsRef.current = [];
      decalsRef.current.forEach(d => {
        scene.remove(d);
        disposeSceneObject(d);
      });
      decalsRef.current = [];

      renderer.dispose();
      renderer.domElement.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Weather Logic ---
  useEffect(() => {
    if (!sceneRef.current || !cloudsRef.current || !sunLightRef.current) return;

    // Clean up previous weather particles
    if (weatherParticlesRef.current) {
      sceneRef.current.remove(weatherParticlesRef.current);
      weatherParticlesRef.current.geometry.dispose();
      (weatherParticlesRef.current.material as THREE.Material).dispose();
      weatherParticlesRef.current = null;
    }

    // Clean up previous storm clouds
    stormCloudsRef.current.forEach(c => {
      cloudsRef.current?.remove(c);
      c.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    });
    stormCloudsRef.current = [];

    if (weather === 'clear' || weather === 'windy') {
      // Restore sun light intensity
      sunLightRef.current.intensity = 2.5;

      // Restore base cloud colors
      cloudsRef.current.children.forEach(cloud => {
        cloud.traverse(child => {
          if (child instanceof THREE.Mesh) {
            (child.material as THREE.MeshStandardMaterial).color.setHex(0xffffff);
            (child.material as THREE.MeshStandardMaterial).opacity = 0.9;
          }
        });
      });

      if (weather === 'windy') {
        // Windy particles (unchanged logic)
        const particleCount = 500;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        for (let i = 0; i < particleCount * 3; i += 3) {
          positions[i] = (Math.random() - 0.5) * 50;
          positions[i + 1] = (Math.random() - 0.5) * 40;
          positions[i + 2] = (Math.random() - 0.5) * 40;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({ 
          color: 0xffffff, size: 0.1, transparent: true, opacity: 0.5 
        });
        const particles = new THREE.Points(geometry, material);
        sceneRef.current.add(particles);
        weatherParticlesRef.current = particles;
      }
      return;
    }

    // --- Rain or Snow: darken existing clouds and add storm clouds ---
    // Dim sun light intensity to simulate heavy cloud cover blocking the sun
    sunLightRef.current.intensity = 1.0;

    const stormColor = weather === 'rain' ? 0x777788 : 0xccccdd;
    const stormOpacity = weather === 'rain' ? 0.95 : 0.9;

    // Darken base clouds
    cloudsRef.current.children.forEach(cloud => {
      cloud.traverse(child => {
        if (child instanceof THREE.Mesh) {
          (child.material as THREE.MeshStandardMaterial).color.setHex(stormColor);
          (child.material as THREE.MeshStandardMaterial).opacity = stormOpacity;
        }
      });
    });

    // Add extra storm clouds
    const extraCloudCount = 40;
    const newStormClouds: THREE.Group[] = [];
    const allCloudPositions: THREE.Vector3[] = [];

    const createStormCloud = (color: number, opacity: number, scale: number) => {
      const cloud = new THREE.Group();
      const cloudGeo = new THREE.SphereGeometry(0.3, 12, 12);
      const cloudMat = new THREE.MeshStandardMaterial({ 
        color, transparent: true, opacity 
      });
      const partCount = 4 + Math.floor(Math.random() * 4);
      for (let j = 0; j < partCount; j++) {
        const part = new THREE.Mesh(cloudGeo, cloudMat);
        part.position.x = (j - partCount / 2) * 0.22;
        part.position.y = Math.sin(j * 0.8) * 0.08;
        part.position.z = (Math.random() - 0.5) * 0.15;
        const s = (0.7 + Math.random() * 0.6) * scale;
        part.scale.set(s, s * 0.6, s);
        cloud.add(part);
      }
      return cloud;
    };

    for (let i = 0; i < extraCloudCount; i++) {
      const cloud = createStormCloud(stormColor, stormOpacity, 1.1 + Math.random() * 0.5);
      // Restrict storm clouds to the same narrow altitude band
      const radius = PLANET_RADIUS + 1.2 + Math.random() * 0.2;
      const phi = Math.random() * Math.PI;
      const theta = Math.random() * Math.PI * 2;
      cloud.position.setFromSphericalCoords(radius, phi, theta);
      cloud.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cloud.position.clone().normalize());
      cloudsRef.current.add(cloud);
      newStormClouds.push(cloud);
      allCloudPositions.push(cloud.position.clone());
    }
    stormCloudsRef.current = newStormClouds;

    // --- Create precipitation particles, each bound to a specific cloud ---
    const totalClouds = cloudsRef.current.children.length;
    const particlesPerCloud = weather === 'rain' ? 250 : 150;
    const particleCount = totalClouds * particlesPerCloud;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const cloudMap = new Int16Array(particleCount); // particle → cloud index
    const fallProgress = new Float32Array(particleCount); // 0..1 fall progress
    const offsets = new Float32Array(particleCount * 2);

    for (let i = 0; i < particleCount; i++) {
      const ci = Math.floor(i / particlesPerCloud); // assign to cloud sequentially
      cloudMap[i] = ci;
      fallProgress[i] = Math.random(); // stagger initial positions

      // Generate random lateral offset within the cloud's horizontal radius
      const r = Math.random() * 0.8; // coverage radius
      const th = Math.random() * Math.PI * 2;
      offsets[i * 2] = r * Math.cos(th);
      offsets[i * 2 + 1] = r * Math.sin(th);

      // Initial positions will be computed by the animation loop
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
    }

    particleCloudMapRef.current = cloudMap;
    particleFallProgressRef.current = fallProgress;
    particleOffsetRef.current = offsets;

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    let material: THREE.PointsMaterial;
    if (weather === 'rain') {
      material = new THREE.PointsMaterial({ 
        color: 0x6ba8f7, 
        size: 0.018, 
        transparent: true, 
        opacity: 0.6,
        blending: THREE.AdditiveBlending
      });
    } else {
      material = new THREE.PointsMaterial({ 
        color: 0xffffff, 
        size: 0.024, 
        transparent: true, 
        opacity: 0.8 
      });
    }

    const particles = new THREE.Points(geometry, material);
    sceneRef.current.add(particles);
    weatherParticlesRef.current = particles;

  }, [weather]);

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-sans">
      {/* 3D Canvas Container */}
      <div ref={containerRef} className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing" />

      {/* Flight Control Overlay */}
      <AnimatePresence>
        {flightMode && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-3 w-full max-w-sm px-4 md:px-0"
          >
            <div className="bg-black/60 backdrop-blur-md px-6 py-4 rounded-2xl border border-white/10 shadow-2xl w-full">
              <h3 className="text-lg font-black text-white mb-2 text-center md:text-left">Flight Controls</h3>
              <div className="flex flex-col gap-2 text-sm text-slate-300 font-medium">
                <div className="flex justify-between items-center"><span className="opacity-80">Accelerate </span><span className="font-mono bg-white/10 px-2 py-0.5 rounded text-white border border-white/5">W / ↑</span></div>
                <div className="flex justify-between items-center"><span className="opacity-80">Decelerate / Reverse</span><span className="font-mono bg-white/10 px-2 py-0.5 rounded text-white border border-white/5">S / ↓</span></div>
                <div className="flex justify-between items-center"><span className="opacity-80">Steer Left / Right</span><span className="font-mono bg-white/10 px-2 py-0.5 rounded text-white border border-white/5">A / D / ← →</span></div>
              </div>
            </div>
            
            <div className="bg-black/60 backdrop-blur-md p-1.5 rounded-2xl border border-white/10 shadow-xl flex gap-1 w-full relative">
               <button 
                onClick={() => setCameraView('third-person')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${cameraView === 'third-person' ? 'bg-sky-500/80 text-white shadow-inner' : 'hover:bg-white/10 text-slate-400'}`}
              >
                3rd Person
              </button>
              <button 
                onClick={() => setCameraView('cockpit')}
                 className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${cameraView === 'cockpit' ? 'bg-sky-500/80 text-white shadow-inner' : 'hover:bg-white/10 text-slate-400'}`}
              >
                Cockpit
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* UI Overlay */}
      <div className="absolute inset-0 pointer-events-none p-4 md:p-8 flex flex-col justify-between z-10">
        {/* Top bar */}
        <div className="flex justify-between items-start">
          <AnimatePresence>
            {!flightMode && (
              <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="p-3 md:p-6 rounded-2xl backdrop-blur-xl border bg-black/50 border-white/10 pointer-events-auto shadow-2xl"
              >
                <h1 className="text-lg md:text-3xl font-black tracking-tight text-white">
                  Tiny Planet
                </h1>
                <p className="text-[9px] md:text-sm font-bold mt-0.5 md:mt-1 text-slate-400">
                  Drag to explore • Scroll to zoom
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-col gap-2 md:gap-4 items-end">
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setIsRotating(!isRotating)}
              className="p-2.5 md:p-4 rounded-full backdrop-blur-xl border pointer-events-auto shadow-xl transition-all bg-white/10 border-white/10 text-white"
            >
              <RotateCcw size={18} className={`md:w-6 md:h-6 ${isRotating ? 'animate-spin-slow' : ''}`} />
            </motion.button>
            
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setIsMuted(!isMuted)}
              className="p-2.5 md:p-4 rounded-full backdrop-blur-xl border pointer-events-auto shadow-xl transition-all bg-white/10 border-white/10 text-white"
            >
              {isMuted ? <VolumeX size={18} className="md:w-6 md:h-6" /> : <Volume2 size={18} className="md:w-6 md:h-6" />}
            </motion.button>

            {!isMuted && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-2 p-2 md:p-4 rounded-2xl backdrop-blur-xl border bg-white/10 border-white/10 pointer-events-auto"
              >
                <input 
                  type="range" 
                  min="0" 
                  max="1" 
                  step="0.01" 
                  value={volume} 
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-20 md:w-32 accent-white"
                />
              </motion.div>
            )}
          </div>
        </div>

        {/* Bottom Controls */}
        <div className="flex flex-col items-center gap-3 md:gap-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex items-center gap-1 md:gap-3 p-1.5 md:p-3 rounded-2xl backdrop-blur-xl border pointer-events-auto shadow-2xl bg-white/20 border-white/20`}
          >
            {/* Weather Buttons */}
            <div className="grid grid-cols-4 gap-1 md:gap-3">
              <WeatherButton 
                active={weather === 'clear'} 
                onClick={() => setWeather('clear')} 
                icon={<Sun size={16} />} 
                label="Clear"
              />
              <WeatherButton 
                active={weather === 'rain'} 
                onClick={() => setWeather('rain')} 
                icon={<CloudRain size={16} />} 
                label="Rain"
              />
              <WeatherButton 
                active={weather === 'snow'} 
                onClick={() => setWeather('snow')} 
                icon={<Snowflake size={16} />} 
                label="Snow"
              />
              <WeatherButton 
                active={weather === 'windy'} 
                onClick={() => setWeather('windy')} 
                icon={<Wind size={16} />} 
                label="Wind"
              />
            </div>

            {/* Separator */}
            <div className="w-px h-10 bg-white/20 mx-1 md:mx-2 hidden md:block"></div>

            {/* Flight/FPS Controls */}
            <div className="flex gap-1 md:gap-3">
              {!fpsMode ? (
                <button
                  onClick={() => {
                    if (flightMode) {
                      setFlightMode(false);
                      setCameraView('orbit');
                    } else {
                      setFlightMode(true);
                      setCameraView('third-person');
                    }
                  }}
                  className={`flex flex-col items-center justify-center px-4 py-2 md:py-3 rounded-xl transition-all duration-300 ${
                    flightMode 
                      ? 'bg-emerald-500/50 text-white shadow-inner scale-95 border border-emerald-400/50' 
                      : 'text-slate-200 hover:bg-white/10 hover:text-white border border-transparent'
                  }`}
                >
                  <Plane size={18} className="md:w-6 md:h-6 mb-1" />
                  <span className="text-[9px] md:text-xs font-bold uppercase tracking-wider hidden sm:block">
                    {flightMode ? 'EXIT CONTROL' : 'FLY'}
                  </span>
                </button>
              ) : (
                <button
                  onClick={() => {
                    setFpsMode(false);
                    setShowFpsInstructions(false);
                    setCameraView('orbit');
                    characterVelocityRef.current.set(0, 0, 0);
                    if (document.pointerLockElement) {
                      document.exitPointerLock();
                    }
                  }}
                  className="flex flex-col items-center justify-center px-4 py-2 md:py-3 rounded-xl bg-orange-500/50 text-white border border-orange-400/50 transition-all"
                >
                  <RotateCcw size={18} className="md:w-6 md:h-6 mb-1" />
                  <span className="text-[9px] md:text-xs font-bold uppercase tracking-wider hidden sm:block">
                    EXIT FPS
                  </span>
                </button>
              )}

              {flightMode && !fpsMode && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  onClick={() => {
                    // Transition to FPS at airplane's location
                    if (airplanePivotRef.current) {
                      const airplane = airplanePivotRef.current.children[0];
                      if (airplane) {
                        const worldPos = new THREE.Vector3();
                        airplane.getWorldPosition(worldPos);
                        characterPosRef.current.copy(worldPos);
                        
                        // Give some initial velocity based on plane forward
                        const worldQuat = new THREE.Quaternion();
                        airplane.getWorldQuaternion(worldQuat);
                        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuat);
                        characterVelocityRef.current.copy(forward.multiplyScalar(0.1));
                        
                        // Reset camera orientation for fresh landing
                        fpsForwardRef.current.copy(
                          getStableSurfaceDirection(worldPos.clone().normalize(), forward)
                        );
                        fpsPitchRef.current = 0;

                        setFpsMode(true);
                        setShowFpsInstructions(true);
                        setFlightMode(false);
                      }
                    }
                  }}
                  className="flex flex-col items-center justify-center px-4 py-2 md:py-3 rounded-xl bg-amber-500/50 text-white border border-amber-400/50 hover:bg-amber-500 transition-all shadow-lg"
                >
                  <Parachute size={24} className="mb-1" />
                  <span className="text-[9px] md:text-xs font-bold uppercase tracking-wider hidden sm:block">
                    JUMP (FPS)
                  </span>
                </motion.button>
              )}
            </div>
          </motion.div>
        </div>

        {/* FPS HUD & Instructions */}
        <AnimatePresence>
          {fpsMode && (
            <>
              {/* Permanent Crosshair */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
                <div className="w-1.5 h-1.5 bg-white/70 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.8)]"></div>
              </div>

              {/* Instructions Overlay (Fades in) */}
              <AnimatePresence>
                {showFpsInstructions && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setShowFpsInstructions(false)}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none z-40"
                  >
                    <div className="bg-black/60 backdrop-blur-md p-8 rounded-[2.5rem] border border-white/20 text-center pointer-events-auto cursor-pointer hover:bg-black/70 transition-colors shadow-2xl">
                      <h3 className="text-white text-2xl font-black mb-6 uppercase tracking-tighter">On Foot Controls</h3>
                      <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-white/90 text-sm mb-6">
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">W S A D</div>
                        <div className="text-left py-1">Walk</div>
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">MOUSE</div>
                        <div className="text-left py-1">Look Around</div>
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">SPACE</div>
                        <div className="text-left py-1">Jump</div>
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">G</div>
                        <div className="text-left py-1">Throw Grenade</div>
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">CLICK</div>
                        <div className="text-left py-1">Lock Cursor / Single Shot</div>
                        <div className="text-right font-mono text-amber-400 bg-white/5 px-2 py-1 rounded">HOLD CLICK</div>
                        <div className="text-left font-bold py-1">Auto Fire</div>
                      </div>
                      <div className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Click anywhere to dismiss</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function WeatherButton({ active, onClick, icon, label }: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode; 
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-2 md:px-5 py-1.5 md:py-3 rounded-xl transition-all ${
        active 
          ? 'bg-white/30 text-white shadow-xl scale-110' 
          : 'text-slate-400 hover:bg-white/10'
      }`}
    >
      <span className={active ? 'scale-125' : ''}>{icon}</span>
      <span className="text-[8px] md:text-sm font-black tracking-tight">{label}</span>
    </button>
  );
}
