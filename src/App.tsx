import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sun, Moon, CloudRain, Snowflake, Wind, Cloud, Play, Pause, Volume2, VolumeX } from 'lucide-react';
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
  const [isDay, setIsDay] = useState(true);
  const [weather, setWeather] = useState<Weather>('clear');
  const [isRotating, setIsRotating] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(0.3);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // High-quality organic nature sounds
  const weatherSounds: Record<Weather, string> = {
    clear: 'https://cdn.pixabay.com/audio/2022/01/18/audio_8033696564.mp3', // Summer forest with birds
    rain: 'https://cdn.pixabay.com/audio/2021/08/09/audio_88447e969f.mp3',  // Soft rain and nature
    snow: 'https://cdn.pixabay.com/audio/2022/02/07/audio_67894f0631.mp3',  // Gentle winter wind
    windy: 'https://cdn.pixabay.com/audio/2022/02/07/audio_67894f0631.mp3', // Gentle winter wind
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
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
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

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 6, 12);
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

    // --- Objects ---
    const windowMat = new THREE.MeshStandardMaterial({ 
      color: 0x111111,
      emissive: 0xffaa00,
      emissiveIntensity: isDay ? 0 : 2
    });
    houseWindowMaterialRef.current = windowMat;

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
      for (let i = 0; i < 4; i++) {
        const windowMesh = new THREE.Mesh(windowGeo, windowMat);
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

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const cloud = new THREE.Group();
      const cloudGeo = new THREE.SphereGeometry(0.3, 12, 12);
      const cloudMat = new THREE.MeshStandardMaterial({ 
        color: 0xffffff, 
        transparent: true, 
        opacity: 0.9 
      });
      
      for (let j = 0; j < 4; j++) {
        const part = new THREE.Mesh(cloudGeo, cloudMat);
        part.position.x = (j - 1.5) * 0.25;
        part.position.y = Math.sin(j) * 0.1;
        part.scale.set(1 - Math.abs(j - 1.5) * 0.3, 1 - Math.abs(j - 1.5) * 0.3, 1 - Math.abs(j - 1.5) * 0.3);
        cloud.add(part);
      }

      const radius = PLANET_RADIUS + 2.0 + Math.random() * 2;
      const phi = Math.random() * Math.PI;
      const theta = Math.random() * Math.PI * 2;
      cloud.position.setFromSphericalCoords(radius, phi, theta);
      cloud.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cloud.position.clone().normalize());
      cloudsGroup.add(cloud);
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

    // --- Lights ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;

    const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
    sunLight.position.set(10, 15, 10);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    scene.add(sunLight);
    sunLightRef.current = sunLight;

    // --- Starfield ---
    const starGeometry = new THREE.BufferGeometry();
    const starCount = 8000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      // Create stars in a large shell around the scene
      const r = 200 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[i] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i + 2] = r * Math.cos(phi);
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.8,
      sizeAttenuation: true,
      transparent: true,
      opacity: isDay ? 0.1 : 0.8,
    });
    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);
    starfieldRef.current = starField;

    // --- Animation Loop ---
    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      
      if (isRotating && planetRef.current) {
        planetRef.current.rotation.y += 0.003;
        cloudsRef.current!.rotation.y += 0.002;
      }

      if (isRotating && airplanePivotRef.current && airplaneTiltRef.current) {
        airplanePivotRef.current.rotation.y += 0.008;
        airplaneTiltRef.current.rotation.x += 0.0005;
        airplaneTiltRef.current.rotation.z += 0.0003;
        
        const airplane = airplanePivotRef.current.children[0];
        if (airplane) {
          const prop = airplane.getObjectByName("propeller");
          if (prop) prop.rotation.z += 0.3;
        }
      }

      if (isRotating && birdPivotsRef.current) {
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

      if (starfieldRef.current) {
        starfieldRef.current.rotation.y += 0.0002;
        starfieldRef.current.rotation.z += 0.0001;
      }

      controls.update();

      // Weather animation
      if (weatherParticlesRef.current) {
        const positions = weatherParticlesRef.current.geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < positions.length; i += 3) {
          if (weather === 'rain') {
            positions[i + 1] -= 0.6;
            if (positions[i + 1] < -20) positions[i + 1] = 20;
          } else if (weather === 'snow') {
            positions[i + 1] -= 0.1;
            positions[i] += Math.sin(Date.now() * 0.001 + i) * 0.04;
            if (positions[i + 1] < -20) positions[i + 1] = 20;
          } else if (weather === 'windy') {
             positions[i] += 0.8;
             positions[i + 1] += Math.sin(Date.now() * 0.002 + i) * 0.1;
             if (positions[i] > 25) positions[i] = -25;
          }
        }
        weatherParticlesRef.current.geometry.attributes.position.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
      renderer.dispose();
      if (containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, [isRotating, weather]);

  // --- Day/Night Logic ---
  useEffect(() => {
    if (!sceneRef.current || !ambientLightRef.current || !sunLightRef.current) return;

    if (isDay) {
      ambientLightRef.current.intensity = 0.8;
      sunLightRef.current.intensity = 1.2;
      sunLightRef.current.color.setHex(0xffffff);
      if (starfieldRef.current) (starfieldRef.current.material as THREE.PointsMaterial).opacity = 0.1;
      if (houseWindowMaterialRef.current) houseWindowMaterialRef.current.emissiveIntensity = 0;
    } else {
      ambientLightRef.current.intensity = 0.2;
      sunLightRef.current.intensity = 0.3;
      sunLightRef.current.color.setHex(0x5555ff);
      if (starfieldRef.current) (starfieldRef.current.material as THREE.PointsMaterial).opacity = 0.8;
      if (houseWindowMaterialRef.current) houseWindowMaterialRef.current.emissiveIntensity = 2.5;
    }
  }, [isDay]);

  // --- Weather Logic ---
  useEffect(() => {
    if (!sceneRef.current) return;

    if (weatherParticlesRef.current) {
      sceneRef.current.remove(weatherParticlesRef.current);
      weatherParticlesRef.current.geometry.dispose();
      (weatherParticlesRef.current.material as THREE.Material).dispose();
      weatherParticlesRef.current = null;
    }

    if (weather === 'clear') return;

    const particleCount = weather === 'windy' ? 500 : 6000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    
    for (let i = 0; i < particleCount * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * 50;
      positions[i + 1] = (Math.random() - 0.5) * 40;
      positions[i + 2] = (Math.random() - 0.5) * 40;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    let material: THREE.PointsMaterial;
    if (weather === 'rain') {
      material = new THREE.PointsMaterial({ 
        color: 0x93c5fd, 
        size: 0.2, 
        transparent: true, 
        opacity: 0.8,
        blending: THREE.AdditiveBlending
      });
    } else if (weather === 'snow') {
      material = new THREE.PointsMaterial({ 
        color: 0xffffff, 
        size: 0.25, 
        transparent: true, 
        opacity: 1.0 
      });
    } else { // windy
      material = new THREE.PointsMaterial({ 
        color: 0xffffff, 
        size: 0.1, 
        transparent: true, 
        opacity: 0.5 
      });
    }

    const particles = new THREE.Points(geometry, material);
    sceneRef.current.add(particles);
    weatherParticlesRef.current = particles;

  }, [weather]);

  return (
    <div className={`relative w-full h-screen overflow-hidden transition-colors duration-1000 ${isDay ? 'bg-sky-300' : 'bg-[#010413]'}`}>
      {/* 3D Canvas Container */}
      <div ref={containerRef} className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing" />

      {/* UI Overlay */}
      <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4 md:p-8 z-10">
        {/* Header */}
        <div className="flex justify-between items-start">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`p-3 md:p-6 rounded-2xl backdrop-blur-xl border ${isDay ? 'bg-white/50 border-white/40' : 'bg-black/50 border-white/10'} pointer-events-auto shadow-2xl`}
          >
            <h1 className={`text-lg md:text-3xl font-black tracking-tight ${isDay ? 'text-slate-900' : 'text-white'}`}>
              Tiny Planet
            </h1>
            <p className={`text-[9px] md:text-sm font-bold mt-0.5 md:mt-1 ${isDay ? 'text-slate-800' : 'text-slate-400'}`}>
              Drag to explore • Scroll to zoom
            </p>
          </motion.div>

          <div className="flex flex-col gap-2 md:gap-4 items-end">
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setIsDay(!isDay)}
              className={`p-2.5 md:p-4 rounded-full backdrop-blur-xl border pointer-events-auto shadow-xl transition-all ${
                isDay ? 'bg-amber-100 border-amber-200 text-amber-600' : 'bg-indigo-900 border-indigo-800 text-indigo-200'
              }`}
            >
              {isDay ? <Sun size={18} className="md:w-6 md:h-6" /> : <Moon size={18} className="md:w-6 md:h-6" />}
            </motion.button>
            
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setIsRotating(!isRotating)}
              className={`p-2.5 md:p-4 rounded-full backdrop-blur-xl border pointer-events-auto shadow-xl transition-all ${
                isDay ? 'bg-white/70 border-white/50 text-slate-900' : 'bg-white/10 border-white/10 text-white'
              }`}
            >
              {isRotating ? <Pause size={18} className="md:w-6 md:h-6" /> : <Play size={18} className="md:w-6 md:h-6" />}
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setIsMuted(!isMuted)}
              className={`p-2.5 md:p-4 rounded-full backdrop-blur-xl border pointer-events-auto shadow-xl transition-all ${
                isMuted 
                  ? 'bg-red-500/20 border-red-500/30 text-red-500' 
                  : (isDay ? 'bg-white/70 border-white/50 text-slate-900' : 'bg-white/10 border-white/10 text-white')
              }`}
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
            className={`grid grid-cols-4 gap-1 md:gap-3 p-1.5 md:p-3 rounded-2xl backdrop-blur-xl border pointer-events-auto shadow-2xl ${
              isDay ? 'bg-white/50 border-white/40' : 'bg-black/50 border-white/10'
            }`}
          >
            <WeatherButton 
              active={weather === 'clear'} 
              onClick={() => setWeather('clear')} 
              icon={<Sun size={16} />} 
              label="Clear"
              isDay={isDay}
            />
            <WeatherButton 
              active={weather === 'rain'} 
              onClick={() => setWeather('rain')} 
              icon={<CloudRain size={16} />} 
              label="Rain"
              isDay={isDay}
            />
            <WeatherButton 
              active={weather === 'snow'} 
              onClick={() => setWeather('snow')} 
              icon={<Snowflake size={16} />} 
              label="Snow"
              isDay={isDay}
            />
            <WeatherButton 
              active={weather === 'windy'} 
              onClick={() => setWeather('windy')} 
              icon={<Wind size={16} />} 
              label="Wind"
              isDay={isDay}
            />
          </motion.div>
          
          <div className={`text-[9px] md:text-xs font-black uppercase tracking-[0.3em] ${isDay ? 'text-slate-800' : 'text-slate-500'}`}>
            {weather} mode
          </div>
        </div>
      </div>

      {/* Atmospheric Overlays */}
      <AnimatePresence>
        {weather === 'rain' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-blue-950/30 pointer-events-none z-0 backdrop-blur-[2px]"
          />
        )}
        {weather === 'snow' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.2 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-white/20 pointer-events-none z-0 backdrop-blur-[1px]"
          />
        )}
        {weather === 'windy' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-200/10 pointer-events-none z-0 backdrop-blur-[0.5px]"
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function WeatherButton({ active, onClick, icon, label, isDay }: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode; 
  label: string;
  isDay: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-2 md:px-5 py-1.5 md:py-3 rounded-xl transition-all ${
        active 
          ? (isDay ? 'bg-white text-slate-900 shadow-xl scale-110' : 'bg-white/30 text-white scale-110') 
          : (isDay ? 'text-slate-800 hover:bg-white/30' : 'text-slate-400 hover:bg-white/10')
      }`}
    >
      <span className={active ? 'scale-125' : ''}>{icon}</span>
      <span className="text-[8px] md:text-sm font-black tracking-tight">{label}</span>
    </button>
  );
}
