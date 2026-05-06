import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type SceneMode = 'compact' | 'expanded';
type AssistantSceneMood = 'offline' | 'idle' | 'attention' | 'typing';

type AssistantSceneManifest = {
  robotModel?: string;
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
  platform: THREE.Mesh;
  screen: THREE.Mesh;
  screenGlow: THREE.PointLight;
  statusLight: THREE.PointLight;
  statusRing: THREE.Mesh;
  sidePanels: THREE.Mesh[];
};

const DEFAULT_MANIFEST: AssistantSceneManifest = {
  robotModel: 'https://modelviewer.dev/shared-assets/models/RobotExpressive.glb',
  animations: {
    idle: 'Idle',
    attention: 'Wave',
    typing: 'Dance',
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
  private readonly clock = new THREE.Clock();
  private readonly loader = new GLTFLoader();
  private readonly objects: SceneObjects;
  private readonly resizeObserver: ResizeObserver;
  private manifest = DEFAULT_MANIFEST;
  private animationFrame = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private gltfRoot: THREE.Object3D | null = null;
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
    this.camera.position.set(0, 1.36, 6.1);
    this.camera.lookAt(0, 1.1, 0);

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
      this.playMoodAnimation();
    } catch {
      this.clearRobotModel();
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
    };
  }

  private createObjects(
    materials: ReturnType<AssistantScene['createSharedMaterials']>,
  ): SceneObjects {
    const root = new THREE.Group();
    const robotPivot = new THREE.Group();
    robotPivot.position.set(0, 0.36, 0.25);
    root.add(robotPivot);

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

    return {
      root,
      robotPivot,
      consoleGroup,
      platform,
      screen,
      screenGlow,
      statusLight,
      statusRing,
      sidePanels,
    };
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight('#DFFBFF', '#1E293B', 1.8));

    const key = new THREE.DirectionalLight('#FFFFFF', 2.3);
    key.position.set(2.8, 4.2, 3.3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight('#7DD3FC', 1.2);
    rim.position.set(-2.6, 1.6, -2.5);
    this.scene.add(rim);
  }

  private async loadRobotModel(url: string): Promise<void> {
    if (!url) return;
    const gltf = await this.loader.loadAsync(url);
    if (this.gltfRoot) {
      this.objects.robotPivot.remove(this.gltfRoot);
    }

    const root = gltf.scene;
    root.name = 'assistantRobotModel';
    root.scale.setScalar(0.54);
    root.position.set(0, -0.12, 0.03);
    root.rotation.y = 0.08;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    this.gltfRoot = root;
    this.clips = gltf.animations || [];
    this.mixer = this.clips.length > 0 ? new THREE.AnimationMixer(root) : null;
    this.objects.robotPivot.add(root);
  }

  private clearRobotModel(): void {
    if (this.gltfRoot) {
      this.objects.robotPivot.remove(this.gltfRoot);
      this.gltfRoot = null;
    }
    this.mixer = null;
    this.clips = [];
    this.activeAction = null;
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

    const targetScale = this.mode === 'expanded' ? 1.1 : 0.9;
    const targetX = this.mode === 'expanded' ? 0.06 : 0;
    this.objects.root.scale.lerp(
      new THREE.Vector3(targetScale, targetScale, targetScale),
      0.08,
    );
    this.objects.root.position.x += (targetX - this.objects.root.position.x) * 0.08;
    this.objects.root.rotation.y =
      Math.sin(elapsed * 0.36) * (this.mode === 'expanded' ? 0.12 : 0.08);

    const floatY = Math.sin(elapsed * 2.2) * 0.035;
    this.objects.robotPivot.position.y = 0.36 + floatY;
    this.objects.robotPivot.rotation.y = Math.sin(elapsed * 1.1) * 0.05;

    const intensityBase =
      this.mood === 'offline' ? 0.35 : this.mood === 'attention' ? 1.7 : 1.1;
    const pulse = 0.72 + Math.sin(elapsed * 4.4) * 0.18;
    this.screenMaterial.emissiveIntensity =
      this.mood === 'typing' ? 0.75 + Math.sin(elapsed * 8) * 0.18 : 0.45;
    this.ringMaterial.emissiveIntensity = intensityBase * pulse;
    this.objects.statusLight.intensity = intensityBase * 1.2;
    this.objects.screenGlow.intensity =
      this.mode === 'expanded' ? intensityBase * 1.4 : intensityBase * 0.6;
    this.objects.statusRing.rotation.z += delta * 0.42;
    this.objects.sidePanels.forEach((panel, index) => {
      panel.position.y = 0.42 + Math.sin(elapsed * 1.7 + index) * 0.025;
      panel.visible = this.mode === 'expanded';
    });
    this.objects.consoleGroup.visible = this.mode === 'expanded';

    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(() => this.animate());
  }
}
