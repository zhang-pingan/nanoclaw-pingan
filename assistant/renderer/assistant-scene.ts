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
  platform: THREE.Mesh;
  screen: THREE.Mesh;
  screenGlow: THREE.PointLight;
  statusLight: THREE.PointLight;
  statusRing: THREE.Mesh;
  backgroundScreen: THREE.Mesh;
  sidePanels: THREE.Mesh[];
  alertBars: THREE.Mesh[];
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
    dark: THREE.MeshStandardMaterial;
    panel: THREE.MeshStandardMaterial;
    screen: THREE.MeshStandardMaterial;
    ring: THREE.MeshStandardMaterial;
    wall: THREE.MeshStandardMaterial;
    wallDark: THREE.MeshStandardMaterial;
  } {
    return {
      dark: new THREE.MeshStandardMaterial({
        color: '#172033',
        roughness: 0.58,
        metalness: 0.1,
      }),
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
      wall: new THREE.MeshStandardMaterial({
        color: '#94A3B8',
        roughness: 0.5,
        metalness: 0.28,
      }),
      wallDark: new THREE.MeshStandardMaterial({
        color: '#1E293B',
        roughness: 0.54,
        metalness: 0.2,
      }),
    };
  }

  private createObjects(
    materials: ReturnType<AssistantScene['createSharedMaterials']>,
  ): SceneObjects {
    const root = new THREE.Group();
    const robotPivot = new THREE.Group();
    robotPivot.position.set(-0.18, 0.72, 0.15);
    root.add(robotPivot);

    const wallGroup = new THREE.Group();
    wallGroup.position.set(0, 0, -1.26);
    root.add(wallGroup);

    const backPanel = new THREE.Mesh(
      new THREE.BoxGeometry(2.9, 1.48, 0.05),
      materials.wallDark,
    );
    backPanel.position.set(0, 0.92, 0);
    backPanel.receiveShadow = true;
    wallGroup.add(backPanel);

    const panelLayout: Array<[number, number, number, number]> = [
      [-0.94, 1.14, 0.62, 0.38],
      [-0.2, 1.18, 0.58, 0.42],
      [0.62, 1.12, 0.74, 0.34],
      [-0.68, 0.64, 0.74, 0.34],
      [0.42, 0.62, 0.96, 0.32],
    ];
    panelLayout.forEach(([x, y, width, height]) => {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, 0.035),
        materials.wall,
      );
      panel.position.set(x, y, 0.04);
      panel.castShadow = true;
      panel.receiveShadow = true;
      wallGroup.add(panel);
    });

    const backgroundScreen = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.42, 0.035),
      materials.screen,
    );
    backgroundScreen.position.set(0.7, 1.14, 0.085);
    wallGroup.add(backgroundScreen);

    const alertBars: THREE.Mesh[] = [];
    [-0.16, 0, 0.16].forEach((x) => {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.055, 0.26, 0.035),
        materials.ring,
      );
      bar.position.set(0.7 + x, 1.13, 0.11);
      wallGroup.add(bar);
      alertBars.push(bar);
    });

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(1.24, 1.42, 0.22, 48),
      materials.panel,
    );
    platform.position.y = 0.02;
    platform.receiveShadow = true;
    root.add(platform);

    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.18, 0.025, 8, 64),
      materials.ring,
    );
    statusRing.rotation.x = Math.PI / 2;
    statusRing.position.y = 0.17;
    root.add(statusRing);

    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(0.95, 0.34, -0.18);
    consoleGroup.rotation.y = -0.48;
    root.add(consoleGroup);

    const consoleBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.74, 0.36, 0.28),
      materials.dark,
    );
    consoleBase.castShadow = true;
    consoleBase.receiveShadow = true;
    consoleGroup.add(consoleBase);

    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.42, 0.04),
      materials.screen,
    );
    screen.position.set(0, 0.38, -0.1);
    screen.rotation.x = -0.17;
    screen.castShadow = true;
    consoleGroup.add(screen);

    const screenGlow = new THREE.PointLight('#38BDF8', 1.2, 2.2);
    screenGlow.position.set(0, 0.42, 0.08);
    consoleGroup.add(screenGlow);

    const sidePanels: THREE.Mesh[] = [];
    [-0.82, 0.82].forEach((x) => {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.62, 0.36),
        materials.dark,
      );
      panel.position.set(x, 0.42, -0.42);
      panel.castShadow = true;
      panel.receiveShadow = true;
      root.add(panel);
      sidePanels.push(panel);
    });

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
      platform,
      screen,
      screenGlow,
      statusLight,
      statusRing,
      backgroundScreen,
      sidePanels,
      alertBars,
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
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
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
    this.targetRootScale.setScalar(expanded ? 1.08 : 1.22);
    this.targetCameraPosition.set(
      expanded ? 0.1 : -0.12,
      expanded ? 1.18 : 1.16,
      expanded ? 4.65 : 3.75,
    );
    this.targetCameraFocus.set(expanded ? 0.04 : -0.12, compactFocus, -0.06);

    this.objects.root.scale.lerp(this.targetRootScale, 0.08);
    const targetX = expanded ? 0.02 : 0.08;
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
    this.objects.robotPivot.position.y = 0.72 + floatY;
    this.objects.robotPivot.position.x =
      -0.18 + Math.sin(elapsed * 1.7) * (this.mood === 'typing' ? 0.025 : 0.01);
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
    this.objects.sidePanels.forEach((panel, index) => {
      panel.position.y = 0.42 + Math.sin(elapsed * 1.7 + index) * 0.025;
      panel.visible = expanded;
    });
    this.objects.alertBars.forEach((bar, index) => {
      const scan = 0.5 + Math.sin(elapsed * 4.6 + index * 0.8) * 0.5;
      bar.scale.y = 0.42 + scan * (this.mood === 'typing' ? 1.15 : 0.72);
      bar.visible = expanded;
    });
    this.objects.consoleGroup.visible = expanded;
    this.objects.wallGroup.visible = expanded;
    this.objects.propGroup.visible = expanded;
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
