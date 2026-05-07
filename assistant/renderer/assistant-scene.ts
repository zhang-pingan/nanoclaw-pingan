import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type SceneMode = 'compact' | 'expanded';
type AssistantSceneMood = 'offline' | 'idle' | 'attention' | 'typing';
type Vec3 = [number, number, number];

type ScenePropManifest = {
  url: string;
  name?: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
  visibleIn?: SceneMode | 'all';
};

type AssistantSceneManifest = {
  theme?: string;
  source?: string;
  license?: string;
  robotModel?: string;
  props?: ScenePropManifest[];
  animations?: Partial<Record<AssistantSceneMood, string>>;
  palette?: Partial<Record<AssistantSceneMood, string>>;
};

type AssistantSceneState = {
  connected: boolean;
  attention: boolean;
  chatOpen: boolean;
  typing: boolean;
};

type SceneObjects = {
  root: THREE.Group;
  robotPivot: THREE.Group;
  consoleGroup: THREE.Group;
  propGroup: THREE.Group;
  wallGroup: THREE.Group;
  viewportGroup: THREE.Group;
  hologramGroup: THREE.Group;
  platform: THREE.Mesh;
  screen: THREE.Mesh;
  hologramMesh: THREE.Mesh;
  hologramScan: THREE.Mesh;
  screenGlow: THREE.PointLight;
  statusLight: THREE.PointLight;
  statusRing: THREE.Mesh;
  starField: THREE.Points;
  dataTicks: THREE.Mesh[];
};

const DEFAULT_MANIFEST: AssistantSceneManifest = {
  robotModel: './assets/scifi/Enemy_EyeDrone.gltf',
  animations: {
    idle: 'Idle',
    attention: 'Hit',
    typing: 'Charging',
    offline: 'Idle',
  },
  palette: {
    idle: '#10B981',
    offline: '#64748B',
    attention: '#F59E0B',
    typing: '#38BDF8',
  },
};

export class AssistantScene {
  private readonly container: HTMLElement;
  private readonly onReady: (ready: boolean) => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  private readonly cameraFocus = new THREE.Vector3(0, 0.72, 0.05);
  private readonly targetCameraPosition = new THREE.Vector3();
  private readonly targetCameraFocus = new THREE.Vector3();
  private readonly targetRootScale = new THREE.Vector3();
  private readonly clock = new THREE.Clock();
  private readonly loader = new GLTFLoader();
  private readonly objects: SceneObjects;
  private readonly resizeObserver: ResizeObserver;
  private hemisphereLight: THREE.HemisphereLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;
  private manifest = DEFAULT_MANIFEST;
  private animationFrame = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private gltfRoot: THREE.Object3D | null = null;
  private propRoots: THREE.Object3D[] = [];
  private clips: THREE.AnimationClip[] = [];
  private activeAction: THREE.AnimationAction | null = null;
  private mood: AssistantSceneMood = 'offline';
  private mode: SceneMode = 'compact';
  private screenMaterial: THREE.MeshStandardMaterial;
  private ringMaterial: THREE.MeshStandardMaterial;
  private disposed = false;
  private renderWidth = 0;
  private renderHeight = 0;

  constructor(
    container: HTMLElement,
    options: { onReady?: (ready: boolean) => void } = {},
  ) {
    this.container = container;
    this.onReady = options.onReady || (() => {});

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'assistant-scene-canvas';
    this.container.append(this.renderer.domElement);

    const materials = this.createSharedMaterials();
    this.screenMaterial = materials.screen;
    this.ringMaterial = materials.ring;
    this.objects = this.createObjects(materials);
    this.scene.add(this.objects.root);
    this.setupLights();
    this.camera.position.set(0, 1.32, 5.7);
    this.camera.lookAt(this.cameraFocus);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.update({
      connected: false,
      attention: false,
      chatOpen: false,
      typing: false,
    });
    this.animationFrame = window.requestAnimationFrame(() => this.animate());
    this.onReady(true);
  }

  async loadManifest(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = (await res.json()) as AssistantSceneManifest;
      this.manifest = {
        ...DEFAULT_MANIFEST,
        ...manifest,
        props: manifest.props || DEFAULT_MANIFEST.props || [],
        animations: {
          ...DEFAULT_MANIFEST.animations,
          ...(manifest.animations || {}),
        },
        palette: {
          ...DEFAULT_MANIFEST.palette,
          ...(manifest.palette || {}),
        },
      };
      await this.loadRobotModel(this.manifest.robotModel || '');
      await this.loadSceneProps(this.manifest.props || []);
      this.playMoodAnimation();
      this.onReady(true);
    } catch {
      this.clearRobotModel();
      this.clearSceneProps();
    }
  }

  update(state: AssistantSceneState): void {
    const nextMode: SceneMode = state.chatOpen ? 'expanded' : 'compact';
    const nextMood: AssistantSceneMood = !state.connected
      ? 'offline'
      : state.typing
        ? 'typing'
        : state.attention
          ? 'attention'
          : 'idle';

    if (this.mode !== nextMode) {
      this.mode = nextMode;
      this.container.classList.toggle('expanded', nextMode === 'expanded');
    }

    if (this.mood !== nextMood) {
      this.mood = nextMood;
      this.playMoodAnimation();
    }

    this.applyMoodColor();
  }

  dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.clearRobotModel();
    this.clearSceneProps();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    });
  }

  private createSharedMaterials(): {
    panel: THREE.MeshStandardMaterial;
    screen: THREE.MeshStandardMaterial;
    ring: THREE.MeshStandardMaterial;
    wallDark: THREE.MeshStandardMaterial;
    glass: THREE.MeshStandardMaterial;
    hologram: THREE.MeshBasicMaterial;
    hologramScan: THREE.MeshBasicMaterial;
  } {
    return {
      panel: new THREE.MeshStandardMaterial({
        color: '#E2E8F0',
        roughness: 0.44,
        metalness: 0.24,
      }),
      screen: new THREE.MeshStandardMaterial({
        color: '#0F172A',
        emissive: '#38BDF8',
        emissiveIntensity: 0.36,
        roughness: 0.32,
        metalness: 0.12,
      }),
      ring: new THREE.MeshStandardMaterial({
        color: '#2DD4BF',
        emissive: '#10B981',
        emissiveIntensity: 0.5,
        roughness: 0.35,
        metalness: 0.25,
      }),
      wallDark: new THREE.MeshStandardMaterial({
        color: '#1E293B',
        roughness: 0.54,
        metalness: 0.2,
      }),
      glass: new THREE.MeshStandardMaterial({
        color: '#0F172A',
        transparent: true,
        opacity: 0.46,
        roughness: 0.18,
        metalness: 0.08,
      }),
      hologram: new THREE.MeshBasicMaterial({
        color: '#34D399',
        transparent: true,
        opacity: 0.72,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      hologramScan: new THREE.MeshBasicMaterial({
        color: '#A7F3D0',
        transparent: true,
        opacity: 0.64,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    };
  }

  private createObjects(
    materials: ReturnType<AssistantScene['createSharedMaterials']>,
  ): SceneObjects {
    const root = new THREE.Group();
    const robotPivot = new THREE.Group();
    robotPivot.position.set(-0.3, 0.72, 0.16);
    root.add(robotPivot);

    const viewportGroup = new THREE.Group();
    viewportGroup.position.set(0, 0.98, -1.82);
    root.add(viewportGroup);

    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(360 * 3);
    for (let i = 0; i < starPositions.length; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 4.8;
      starPositions[i + 1] = Math.random() * 2.2 - 0.62;
      starPositions[i + 2] = Math.random() * 0.8 - 0.42;
    }
    starGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(starPositions, 3),
    );
    const starField = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: '#E0F2FE',
        size: 0.018,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    );
    viewportGroup.add(starField);

    const wallGroup = new THREE.Group();
    wallGroup.position.set(0, 0, -1.26);
    root.add(wallGroup);

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(0.74, 0.88, 0.16, 48),
      materials.panel,
    );
    platform.position.set(-0.18, 0.06, 0.12);
    platform.receiveShadow = true;
    root.add(platform);

    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.024, 8, 64),
      materials.ring,
    );
    statusRing.rotation.x = Math.PI / 2;
    statusRing.position.set(-0.18, 0.16, 0.12);
    root.add(statusRing);

    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(0, 1.34, -0.86);
    root.add(consoleGroup);

    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.44, 0.04),
      materials.screen,
    );
    screen.position.set(0, 0, -0.1);
    screen.rotation.x = 0.03;
    screen.castShadow = true;
    consoleGroup.add(screen);

    [
      { x: -0.88, rotationY: 0.34 },
      { x: 0.88, rotationY: -0.34 },
    ].forEach(({ x, rotationY }) => {
      const sideScreen = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.36, 0.038),
        materials.screen,
      );
      sideScreen.position.set(x, -0.03, -0.08);
      sideScreen.rotation.y = rotationY;
      sideScreen.castShadow = true;
      consoleGroup.add(sideScreen);

      for (let i = 0; i < 5; i += 1) {
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(0.12 - (i % 2) * 0.04, 0.01, 0.006),
          materials.ring,
        );
        tick.position.set(-0.06, 0.08 - i * 0.04, 0.025);
        sideScreen.add(tick);
      }
    });

    const dataTicks: THREE.Mesh[] = [];
    const stripeGroupCenters = [-0.22];
    const stripeWidths = [0.18, 0.13, 0.16, 0.11];
    stripeGroupCenters.forEach((groupX) => {
      stripeWidths.forEach((width, index) => {
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.012, 0.008),
          materials.ring,
        );
        tick.position.set(groupX, 0.075 - index * 0.05, 0.032);
        tick.userData.kind = 'staticStripe';
        screen.add(tick);
        dataTicks.push(tick);
      });
    });

    for (let i = 0; i < 3; i += 1) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.048, 0.16, 0.008),
        materials.ring,
      );
      tick.position.set(0.13 + (i - 1) * 0.082, 0, 0.032);
      tick.userData.kind = 'dynamicBar';
      screen.add(tick);
      dataTicks.push(tick);
    }

    const screenGlow = new THREE.PointLight('#38BDF8', 1.2, 2.2);
    screenGlow.position.set(0, 0.04, 0.08);
    consoleGroup.add(screenGlow);

    const hologramGroup = new THREE.Group();
    hologramGroup.position.set(0.06, 0.7, -0.32);
    root.add(hologramGroup);

    const hologramGeometry = new THREE.PlaneGeometry(1.38, 0.76, 36, 18);
    const positions = hologramGeometry.attributes
      .position as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const ridge =
        Math.exp(-Math.pow(x * 2.2 - 0.18, 2) - Math.pow(y * 3.2, 2)) * 0.18 +
        Math.exp(-Math.pow(x * 3.4 + 0.78, 2) - Math.pow(y * 2.4 - 0.36, 2)) *
          0.1;
      positions.setZ(i, ridge + Math.sin((x + y) * 9) * 0.018);
    }
    positions.needsUpdate = true;
    hologramGeometry.computeVertexNormals();

    const hologramMesh = new THREE.Mesh(hologramGeometry, materials.hologram);
    hologramMesh.rotation.x = -Math.PI / 2;
    hologramGroup.add(hologramMesh);

    const hologramScan = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.018, 0.78),
      materials.hologramScan,
    );
    hologramScan.position.set(-0.66, 0.04, 0);
    hologramGroup.add(hologramScan);

    const statusLight = new THREE.PointLight('#10B981', 1.35, 3.2);
    statusLight.position.set(0, 1.38, 1.1);
    root.add(statusLight);

    const propGroup = new THREE.Group();
    root.add(propGroup);

    return {
      root,
      robotPivot,
      consoleGroup,
      propGroup,
      wallGroup,
      viewportGroup,
      hologramGroup,
      platform,
      screen,
      hologramMesh,
      hologramScan,
      screenGlow,
      statusLight,
      statusRing,
      starField,
      dataTicks,
    };
  }

  private setupLights(): void {
    this.hemisphereLight = new THREE.HemisphereLight('#DFFBFF', '#1E293B', 1.8);
    this.scene.add(this.hemisphereLight);

    this.keyLight = new THREE.DirectionalLight('#FFFFFF', 2.3);
    this.keyLight.position.set(2.8, 4.2, 3.3);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight('#7DD3FC', 1.2);
    this.rimLight.position.set(-2.6, 1.6, -2.5);
    this.scene.add(this.rimLight);
  }

  private async loadRobotModel(url: string): Promise<void> {
    if (!url) return;
    const gltf = await this.loader.loadAsync(url);
    this.clearRobotModel();

    const root = gltf.scene;
    root.name = 'assistantRobotModel';
    root.scale.setScalar(1.18);
    root.position.set(0, 0, 0.02);
    root.rotation.y = 0.16;
    this.configureLoadedObject(root);

    this.gltfRoot = root;
    this.clips = gltf.animations || [];
    this.mixer = this.clips.length > 0 ? new THREE.AnimationMixer(root) : null;
    this.objects.robotPivot.add(root);
  }

  private clearRobotModel(): void {
    if (this.gltfRoot) {
      this.objects.robotPivot.remove(this.gltfRoot);
      this.disposeObject(this.gltfRoot);
      this.gltfRoot = null;
    }
    this.mixer = null;
    this.clips = [];
    this.activeAction = null;
  }

  private async loadSceneProps(props: ScenePropManifest[]): Promise<void> {
    this.clearSceneProps();
    const roots = await Promise.all(
      props.map(async (prop) => {
        const gltf = await this.loader.loadAsync(prop.url);
        const root = gltf.scene;
        root.name = prop.name || prop.url.split('/').pop() || 'sceneProp';
        root.userData.visibleIn = prop.visibleIn || 'expanded';
        this.applyTransform(root, prop);
        this.configureLoadedObject(root);
        return root;
      }),
    );

    roots.forEach((root) => {
      this.objects.propGroup.add(root);
    });
    this.propRoots = roots;
  }

  private clearSceneProps(): void {
    this.propRoots.forEach((root) => {
      this.objects.propGroup.remove(root);
      this.disposeObject(root);
    });
    this.propRoots = [];
  }

  private applyTransform(
    object: THREE.Object3D,
    manifest: ScenePropManifest,
  ): void {
    const position = manifest.position || [0, 0, 0];
    const rotation = manifest.rotation || [0, 0, 0];
    object.position.set(position[0], position[1], position[2]);
    object.rotation.set(rotation[0], rotation[1], rotation[2]);

    if (Array.isArray(manifest.scale)) {
      object.scale.set(manifest.scale[0], manifest.scale[1], manifest.scale[2]);
    } else {
      object.scale.setScalar(manifest.scale || 1);
    }
  }

  private configureLoadedObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    });
  }

  private playMoodAnimation(): void {
    if (!this.mixer || this.clips.length === 0) return;
    const desiredName = this.manifest.animations?.[this.mood] || 'Idle';
    const clip =
      THREE.AnimationClip.findByName(this.clips, desiredName) ||
      this.clips.find((item) =>
        item.name.toLowerCase().includes(desiredName.toLowerCase()),
      ) ||
      this.clips[0];
    if (!clip) return;

    const nextAction = this.mixer.clipAction(clip);
    if (nextAction === this.activeAction) return;
    nextAction.reset().fadeIn(0.18).play();
    if (this.activeAction) this.activeAction.fadeOut(0.18);
    this.activeAction = nextAction;
  }

  private applyMoodColor(): void {
    const color = new THREE.Color(
      this.manifest.palette?.[this.mood] ||
        DEFAULT_MANIFEST.palette?.[this.mood] ||
        '#10B981',
    );
    this.screenMaterial.emissive.copy(color);
    this.ringMaterial.emissive.copy(color);
    this.ringMaterial.color.copy(color);
    this.objects.statusLight.color.copy(color);
    this.objects.screenGlow.color.copy(color);
    const hologramMaterial = this.objects.hologramMesh
      .material as THREE.MeshBasicMaterial;
    const hologramScanMaterial = this.objects.hologramScan
      .material as THREE.MeshBasicMaterial;
    hologramMaterial.color.copy(color);
    hologramScanMaterial.color.copy(color);
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.renderWidth && height === this.renderHeight) return;
    this.renderWidth = width;
    this.renderHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate(): void {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;
    this.mixer?.update(delta);

    const expanded = this.mode === 'expanded';
    const compactFocus = this.mood === 'typing' ? 0.78 : 0.7;
    const targetFov = expanded ? 42 : 34;
    this.camera.fov += (targetFov - this.camera.fov) * 0.08;
    this.camera.updateProjectionMatrix();
    this.targetRootScale.setScalar(expanded ? 0.88 : 1.22);
    this.targetCameraPosition.set(
      expanded ? 0.08 : -0.12,
      expanded ? 1.24 : 1.16,
      expanded ? 6.15 : 3.75,
    );
    this.targetCameraFocus.set(
      expanded ? 0.0 : -0.12,
      expanded ? 0.76 : compactFocus,
      expanded ? -0.58 : -0.06,
    );

    this.objects.root.scale.lerp(this.targetRootScale, 0.08);
    const targetX = expanded ? 0.06 : 0.08;
    this.objects.root.position.x +=
      (targetX - this.objects.root.position.x) * 0.08;
    this.objects.root.rotation.y =
      Math.sin(elapsed * 0.34) * (expanded ? 0.08 : 0.05);
    this.camera.position.lerp(this.targetCameraPosition, 0.08);
    this.cameraFocus.lerp(this.targetCameraFocus, 0.08);
    this.camera.lookAt(this.cameraFocus);

    const floatY =
      Math.sin(elapsed * (this.mood === 'typing' ? 3.3 : 2.2)) *
      (this.mood === 'typing' ? 0.05 : 0.035);
    const targetRobotScale = expanded ? 0.66 : 1;
    const targetRobotX = expanded ? -0.92 : -0.18;
    const targetRobotY = expanded ? 0.58 : 0.72;
    const targetRobotZ = expanded ? 0.14 : 0.15;
    const targetPlatformY = expanded ? 0.04 : 0.06;
    const targetRingY = expanded ? 0.13 : 0.16;
    this.objects.robotPivot.scale.lerp(
      new THREE.Vector3(targetRobotScale, targetRobotScale, targetRobotScale),
      0.08,
    );
    this.objects.robotPivot.position.y = targetRobotY + floatY;
    this.objects.robotPivot.position.x =
      targetRobotX +
      Math.sin(elapsed * 1.7) * (this.mood === 'typing' ? 0.025 : 0.01);
    this.objects.robotPivot.position.z +=
      (targetRobotZ - this.objects.robotPivot.position.z) * 0.08;
    this.objects.platform.position.x +=
      (targetRobotX - this.objects.platform.position.x) * 0.08;
    this.objects.platform.position.y +=
      (targetPlatformY - this.objects.platform.position.y) * 0.08;
    this.objects.platform.position.z +=
      (targetRobotZ - this.objects.platform.position.z) * 0.08;
    this.objects.platform.scale.lerp(
      new THREE.Vector3(targetRobotScale, 1, targetRobotScale),
      0.08,
    );
    this.objects.statusRing.position.x +=
      (targetRobotX - this.objects.statusRing.position.x) * 0.08;
    this.objects.statusRing.position.y +=
      (targetRingY - this.objects.statusRing.position.y) * 0.08;
    this.objects.statusRing.position.z +=
      (targetRobotZ - this.objects.statusRing.position.z) * 0.08;
    this.objects.statusRing.scale.lerp(
      new THREE.Vector3(targetRobotScale, targetRobotScale, targetRobotScale),
      0.08,
    );
    this.objects.robotPivot.rotation.y =
      Math.sin(elapsed * 1.1) * (this.mood === 'attention' ? 0.12 : 0.05);
    this.objects.robotPivot.rotation.z =
      this.mood === 'typing' ? Math.sin(elapsed * 5.2) * 0.045 : 0;

    const intensityBase =
      this.mood === 'offline'
        ? 0.26
        : this.mood === 'attention'
          ? 1.75
          : this.mood === 'typing'
            ? 1.28
            : 1.0;
    const attentionFlash =
      this.mood === 'attention'
        ? Math.sin(elapsed * 13) > 0.52
          ? 1.75
          : 0.76
        : 1;
    const pulse = 0.72 + Math.sin(elapsed * 4.4) * 0.18;
    this.screenMaterial.emissiveIntensity =
      this.mood === 'offline'
        ? 0.12
        : this.mood === 'typing'
          ? 0.76 + Math.sin(elapsed * 8) * 0.2
          : this.mood === 'attention'
            ? 0.62 * attentionFlash
            : 0.42;
    this.ringMaterial.emissiveIntensity = intensityBase * pulse;
    this.objects.statusLight.intensity = intensityBase * 1.2;
    this.objects.screenGlow.intensity = expanded
      ? intensityBase * attentionFlash * 1.4
      : intensityBase * 0.6;
    this.objects.statusRing.rotation.z += delta * 0.42;
    this.objects.platform.visible = !expanded;
    this.objects.statusRing.visible = !expanded;
    this.objects.starField.rotation.z += delta * 0.012;
    this.objects.hologramGroup.position.y =
      0.7 + Math.sin(elapsed * 2.7) * 0.022;
    this.objects.hologramScan.position.x = -0.68 + ((elapsed * 0.58) % 1.36);
    const hologramMaterial = this.objects.hologramMesh
      .material as THREE.MeshBasicMaterial;
    const hologramScanMaterial = this.objects.hologramScan
      .material as THREE.MeshBasicMaterial;
    hologramMaterial.opacity =
      this.mood === 'offline' ? 0.18 : 0.58 + Math.sin(elapsed * 3.6) * 0.1;
    hologramScanMaterial.opacity =
      this.mood === 'offline' ? 0.12 : 0.48 + Math.sin(elapsed * 7.2) * 0.16;
    this.objects.dataTicks.forEach((tick, index) => {
      if (tick.userData.kind === 'staticStripe') {
        tick.scale.set(1, 1, 1);
        tick.visible = expanded;
        return;
      }
      const glow =
        this.mood === 'typing'
          ? 0.64 + Math.sin(elapsed * 8 + index * 0.5) * 0.36
          : 0.56 + Math.sin(elapsed * 3.4 + index) * 0.18;
      tick.scale.x = 1;
      tick.scale.y = 0.65 + glow * 1.35;
      tick.visible = expanded;
    });
    this.objects.consoleGroup.visible = expanded;
    this.objects.wallGroup.visible = expanded;
    this.objects.propGroup.visible = expanded;
    this.objects.viewportGroup.visible = expanded;
    this.objects.hologramGroup.visible = expanded;
    this.propRoots.forEach((root) => {
      const visibleIn = root.userData
        .visibleIn as ScenePropManifest['visibleIn'];
      root.visible = visibleIn === 'all' || visibleIn === this.mode;
    });

    const offlineDim = this.mood === 'offline' ? 0.34 : 1;
    if (this.hemisphereLight) this.hemisphereLight.intensity = 1.8 * offlineDim;
    if (this.keyLight) this.keyLight.intensity = 2.3 * offlineDim;
    if (this.rimLight) this.rimLight.intensity = 1.2 * offlineDim;

    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(() => this.animate());
  }
}
