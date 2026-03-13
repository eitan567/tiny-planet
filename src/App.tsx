import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sun, CloudRain, Snowflake, Wind, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
type Weather = 'clear' | 'rain' | 'snow' | 'windy';

// --- Constants ---
const PLANET_RADIUS = 5;
const TREE_COUNT = 180;
const HOUSE_COUNT = 45;
const CLOUD_COUNT = 30;
const WATER_LEVEL = 0.998; // Relative to PLANET_RADIUS

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [weather, setWeather] = useState<Weather>('clear');
  const [isRotating, setIsRotating] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(0.3);
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
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
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

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    
    // Orthographic Camera completely eliminates perspective/fisheye distortion
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 18;
    const camera = new THREE.OrthographicCamera(
      frustumSize * aspect / -2,
      frustumSize * aspect / 2,
      frustumSize / 2,
      frustumSize / -2,
      0.1,
      1000
    );
    camera.position.set(0, 6, 18);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // --- Controls ---
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.rotateSpeed = 0.8;
    controls.minDistance = 7;
    controls.maxDistance = 25;
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

    // Helper for Terrain Height
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

    const addTree = (pos: THREE.Vector3) => {
      // Adjust position to terrain height
      const direction = pos.clone().normalize();
      const displacement = getTerrainHeight(pos);
      const adjustedPos = direction.multiplyScalar(PLANET_RADIUS + displacement);

      // Skip trees in water or on snow
      if (adjustedPos.length() < PLANET_RADIUS * WATER_LEVEL + 0.02) return;
      if (displacement > 0.30) return; // No trees on snow peaks

      const tree = new THREE.Group();
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
      
      if (isRotatingRef.current && planetRef.current) {
        planetRef.current.rotation.y += 0.003;
        cloudsRef.current!.rotation.y += 0.002;
      }

      if (isRotatingRef.current && airplanePivotRef.current && airplaneTiltRef.current) {
        airplanePivotRef.current.rotation.y += 0.008;
        airplaneTiltRef.current.rotation.x += 0.0005;
        airplaneTiltRef.current.rotation.z += 0.0003;
        
        const airplane = airplanePivotRef.current.children[0];
        if (airplane) {
          const prop = airplane.getObjectByName("propeller");
          if (prop) prop.rotation.z += 0.3;
        }
      }

      if (isRotatingRef.current && birdPivotsRef.current) {
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

      controls.update();

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

      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const aspect = window.innerWidth / window.innerHeight;
      const frustumSize = 18;
      
      const orthoCam = camera as THREE.OrthographicCamera;
      orthoCam.left = -frustumSize * aspect / 2;
      orthoCam.right = frustumSize * aspect / 2;
      orthoCam.top = frustumSize / 2;
      orthoCam.bottom = -frustumSize / 2;
      
      orthoCam.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
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

      {/* UI Overlay */}
      <div className="absolute inset-0 pointer-events-none p-4 md:p-8 flex flex-col justify-between z-10">
        {/* Top bar */}
        <div className="flex justify-between items-start">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="p-3 md:p-6 rounded-2xl backdrop-blur-xl border bg-black/50 border-white/10 pointer-events-auto shadow-2xl"
          >
            <h1 className="text-lg md:text-3xl font-black tracking-tight text-white">
              Tiny Planet
            </h1>
            <p className="text-[9px] md:text-sm font-bold mt-0.5 md:mt-1 text-slate-400">
              Drag to explore • Scroll to zoom
            </p>
          </motion.div>

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
            className={`grid grid-cols-4 gap-1 md:gap-3 p-1.5 md:p-3 rounded-2xl backdrop-blur-xl border pointer-events-auto shadow-2xl bg-white/20 border-white/20`}
          >
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
          </motion.div>
          
          <div className={`text-[9px] md:text-xs font-black uppercase tracking-[0.3em] text-white/50`}>
            {weather} mode
          </div>
        </div>
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
