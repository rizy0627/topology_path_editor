import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  edgeKey,
  getTemporaryPoints,
  interpolatePolylinePathPoints,
  isPathLocked,
  temporaryPointKey,
} from '../helpers/pathInterpolation';
import { getTypeColor } from '../helpers/colors';
import { getPointRotationRadians } from '../helpers/rotation';

const NODE_RADIUS = 0.18;
const TEMP_POINT_RADIUS = 0.14;
const GOAL_POSE_RADIUS = 0.2;
const LABEL_SCALE = 0.45;
const PATH_ARROW_LIMIT = 90;
const VIEW_FACE_PRESETS = {
  top: {
    direction: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
  },
  bottom: {
    direction: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
  },
  front: {
    direction: new THREE.Vector3(0, -1, 0),
    up: new THREE.Vector3(0, 0, 1),
  },
  back: {
    direction: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, 1),
  },
  left: {
    direction: new THREE.Vector3(-1, 0, 0),
    up: new THREE.Vector3(0, 0, 1),
  },
  right: {
    direction: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 0, 1),
  },
};

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose());
    } else if (child.material) {
      child.material.dispose();
    }
    if (child.material?.map) child.material.map.dispose();
  });
}

function createNodeLabel(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  context.strokeStyle = color;
  context.lineWidth = 4;
  roundRect(context, 20, 12, 88, 40, 18);
  context.fill();
  context.stroke();
  context.fillStyle = '#111827';
  context.font = '700 24px Inter, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(text), 64, 33);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_SCALE, LABEL_SCALE * 0.5, 1);
  sprite.position.set(0, 0, NODE_RADIUS * 2.9);
  return sprite;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function makePointCloud(mapData, pointCloudStyle = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mapData.positions, 3));
  geometry.computeBoundingBox();

  const material = new THREE.PointsMaterial({
    color: pointCloudStyle.color || '#38bdf8',
    size: Number(pointCloudStyle.size) || 0.035,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.82,
    clippingPlanes: pointCloudStyle.clippingPlanes || [],
    clipIntersection: false,
  });

  const points = new THREE.Points(geometry, material);
  points.userData.kind = 'map';
  return points;
}

function makePickedPointMarker(point) {
  const group = new THREE.Group();
  group.position.set(Number(point?.x) || 0, Number(point?.y) || 0, Number(point?.z) || 0);
  group.userData = { kind: 'pickedPointMarkerGroup' };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));

  const halo = new THREE.Points(
    geometry.clone(),
    new THREE.PointsMaterial({
      color: '#22c55e',
      size: 0.13,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    }),
  );
  halo.userData = { kind: 'pickedPointMarkerHalo', parentGroup: group };
  group.add(halo);

  const marker = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: '#facc15',
      size: 0.07,
      sizeAttenuation: true,
      depthTest: false,
    }),
  );
  marker.userData = { kind: 'pickedPointMarker', parentGroup: group };
  group.add(marker);

  return group;
}

function makePathOverlay(pathData, color = '#f43f5e') {
  const positions = pathData.positions;
  const group = new THREE.Group();
  group.userData = { kind: 'pathOverlay' };

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.95,
    }),
  );
  line.userData = { kind: 'pathOverlayLine' };
  group.add(line);

  const markerGeometry = new THREE.BufferGeometry();
  markerGeometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  const markers = new THREE.Points(
    markerGeometry,
    new THREE.PointsMaterial({
      color: new THREE.Color(color).getHex(),
      size: 0.055,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
    }),
  );
  markers.userData = { kind: 'pathOverlayMarkers' };
  group.add(markers);

  return group;
}

function makeGoalPose(pose) {
  const group = new THREE.Group();
  const { position, orientation } = pose;
  group.position.set(position.x, position.y, position.z);
  group.userData = { kind: 'goalPoseGroup', id: pose.id };

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(GOAL_POSE_RADIUS, 20, 14),
    new THREE.MeshStandardMaterial({
      color: '#e879f9',
      emissive: '#a21caf',
      emissiveIntensity: 0.32,
      roughness: 0.35,
      metalness: 0.08,
    }),
  );
  marker.userData = { kind: 'goalPose', id: pose.id };
  group.add(marker);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(GOAL_POSE_RADIUS * 1.45, 0.025, 8, 40),
    new THREE.MeshBasicMaterial({ color: '#f0abfc', depthTest: false }),
  );
  ring.userData = { kind: 'goalPoseRing', id: pose.id };
  group.add(ring);

  const quaternion = new THREE.Quaternion(
    orientation.x,
    orientation.y,
    orientation.z,
    orientation.w,
  );
  const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize();
  const arrow = new THREE.ArrowHelper(
    direction,
    new THREE.Vector3(0, 0, GOAL_POSE_RADIUS * 1.1),
    GOAL_POSE_RADIUS * 3.2,
    new THREE.Color('#facc15').getHex(),
    GOAL_POSE_RADIUS * 1.2,
    GOAL_POSE_RADIUS * 0.7,
  );
  arrow.userData = { kind: 'goalPoseArrow', id: pose.id };
  group.add(arrow);
  group.add(createNodeLabel(`G${pose.id}`, '#c026d3'));

  return group;
}

function makeGoalPosesOverlay(goalPoses = []) {
  const group = new THREE.Group();
  group.userData = { kind: 'goalPosesOverlay' };
  goalPoses.forEach((pose) => group.add(makeGoalPose(pose)));
  return group;
}

function getNearestScreenPoint(pointsObject, event, camera, domElement, range) {
  const position = pointsObject?.geometry?.attributes?.position;
  if (!position) return null;

  const rect = domElement.getBoundingClientRect();
  const targetX = event.clientX - rect.left;
  const targetY = event.clientY - rect.top;
  const worldPoint = new THREE.Vector3();
  const screenPoint = new THREE.Vector3();
  const maxPixelDistance = 10;
  let best = null;
  let bestDistanceSq = maxPixelDistance * maxPixelDistance;

  for (let index = 0; index < position.count; index += 1) {
    worldPoint
      .set(position.getX(index), position.getY(index), position.getZ(index))
      .applyMatrix4(pointsObject.matrixWorld);

    if (!isPointInsideRange(worldPoint, range)) continue;

    screenPoint.copy(worldPoint).project(camera);
    if (screenPoint.z < -1 || screenPoint.z > 1) continue;

    const screenX = ((screenPoint.x + 1) / 2) * rect.width;
    const screenY = ((1 - screenPoint.y) / 2) * rect.height;
    const distanceSq = ((screenX - targetX) ** 2) + ((screenY - targetY) ** 2);

    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = {
        x: worldPoint.x,
        y: worldPoint.y,
        z: worldPoint.z,
        index,
      };
    }
  }

  return best;
}

function makeClippingPlanes(range) {
  if (!range) return [];
  return [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -Number(range.x?.[0] || 0)),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), Number(range.x?.[1] || 0)),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -Number(range.y?.[0] || 0)),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), Number(range.y?.[1] || 0)),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -Number(range.z?.[0] || 0)),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), Number(range.z?.[1] || 0)),
  ];
}

function isPointInsideRange(point, range) {
  if (!range) return true;
  return (
    point.x >= Number(range.x?.[0] ?? -Infinity) &&
    point.x <= Number(range.x?.[1] ?? Infinity) &&
    point.y >= Number(range.y?.[0] ?? -Infinity) &&
    point.y <= Number(range.y?.[1] ?? Infinity) &&
    point.z >= Number(range.z?.[0] ?? -Infinity) &&
    point.z <= Number(range.z?.[1] ?? Infinity)
  );
}

function makeRotationArrow(point, options = {}) {
  const {
    color = '#0f766e',
    length = 0.34,
    opacity = 0.9,
    zOffset = 0.08,
    local = false,
  } = options;
  const radians = getPointRotationRadians(point, 0);
  const direction = new THREE.Vector3(Math.cos(radians), Math.sin(radians), 0).normalize();
  const origin = local
    ? new THREE.Vector3(0, 0, zOffset)
    : new THREE.Vector3(
        Number(point?.x) || 0,
        Number(point?.y) || 0,
        (Number(point?.z) || 0) + zOffset,
      );
  const arrow = new THREE.ArrowHelper(
    direction,
    origin,
    length,
    new THREE.Color(color).getHex(),
    length * 0.38,
    length * 0.22,
  );
  arrow.userData = { kind: 'rotationArrow' };
  arrow.line.material.transparent = true;
  arrow.line.material.opacity = opacity;
  arrow.cone.material.transparent = true;
  arrow.cone.material.opacity = opacity;
  return arrow;
}

function makeNode(node, selectedNodeId) {
  const color = getTypeColor(node.type);
  const selected = Number(selectedNodeId) === Number(node.id);
  const group = new THREE.Group();
  group.position.set(Number(node.x) || 0, Number(node.y) || 0, Number(node.z) || 0);
  group.userData = { kind: 'nodeGroup', id: Number(node.id) };

  const geometry = new THREE.SphereGeometry(NODE_RADIUS, 24, 16);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.05,
    emissive: selected ? color : '#000000',
    emissiveIntensity: selected ? 0.35 : 0,
  });
  const sphere = new THREE.Mesh(geometry, material);
  sphere.userData = { kind: 'node', id: Number(node.id), parentGroup: group };
  group.add(sphere);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(NODE_RADIUS * 1.35, 0.018, 8, 36),
    new THREE.MeshBasicMaterial({
      color: Number(selectedNodeId) === Number(node.id) ? '#111827' : color,
      transparent: true,
      opacity: selected ? 0.95 : 0.38,
    }),
  );
  ring.userData = { kind: 'nodeRing', id: Number(node.id), parentGroup: group };
  group.add(ring);

  group.add(makeRotationArrow(node, {
    color: selected ? '#dc2626' : color,
    length: selected ? NODE_RADIUS * 3 : NODE_RADIUS * 2.35,
    opacity: selected ? 1 : 0.72,
    zOffset: NODE_RADIUS * 1.35,
    local: true,
  }));
  group.add(createNodeLabel(node.id, color));
  return group;
}

function makeTemporaryPoint(edge, edgeIndex, point, pointIndex, selectedEdgeKey, selectedTempPointKey) {
  const edgeSelectionKey = edgeKey(edge, edgeIndex);
  const key = temporaryPointKey(edge, edgeIndex, pointIndex);
  const selected = key === selectedTempPointKey;
  const edgeSelected = selected || edgeSelectionKey === selectedEdgeKey;
  const locked = isPathLocked(edge);
  const group = new THREE.Group();
  group.position.set(Number(point.x) || 0, Number(point.y) || 0, Number(point.z) || 0);
  group.userData = { kind: 'temporaryPointGroup', key, edgeKey: edgeSelectionKey, edgeIndex, pointIndex, locked };

  const material = new THREE.MeshStandardMaterial({
    color: locked ? '#94a3b8' : selected ? '#ea580c' : '#fb923c',
    roughness: 0.42,
    metalness: 0.04,
    emissive: edgeSelected && !locked ? '#fb923c' : '#000000',
    emissiveIntensity: edgeSelected ? 0.28 : 0,
  });
  const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(TEMP_POINT_RADIUS, 0), material);
  diamond.userData = {
    kind: 'temporaryPoint',
    key,
    edgeKey: edgeSelectionKey,
    edgeIndex,
    pointIndex,
    locked,
    parentGroup: group,
  };
  group.add(diamond);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(TEMP_POINT_RADIUS * 1.55, 0.015, 8, 36),
    new THREE.MeshBasicMaterial({
      color: locked ? '#64748b' : selected ? '#7c2d12' : '#fb923c',
      transparent: true,
      opacity: edgeSelected ? 0.9 : 0.46,
    }),
  );
  ring.userData = {
    kind: 'temporaryPointRing',
    key,
    edgeKey: edgeSelectionKey,
    edgeIndex,
    pointIndex,
    locked,
    parentGroup: group,
  };
  group.add(ring);

  return group;
}

function makeEdge(edge, index, selectedEdgeKey) {
  const key = edgeKey(edge, index);
  const selected = key === selectedEdgeKey;
  const locked = isPathLocked(edge);
  const points = edge.path_points || [];
  const positions = new Float32Array(points.length * 3);

  points.forEach((point, pointIndex) => {
    const offset = pointIndex * 3;
    positions[offset] = Number(point.x) || 0;
    positions[offset + 1] = Number(point.y) || 0;
    positions[offset + 2] = Number(point.z) || 0;
  });

  const group = new THREE.Group();
  group.userData = { kind: 'edgeGroup', key, index };

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color: locked ? '#64748b' : selected ? '#ef4444' : '#1f2937',
      transparent: true,
      opacity: selected || locked ? 1 : 0.72,
    }),
  );
  line.userData = { kind: 'edge', key, index, role: 'line' };
  group.add(line);

  const markerGeometry = new THREE.BufferGeometry();
  markerGeometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  const markers = new THREE.Points(
    markerGeometry,
    new THREE.PointsMaterial({
      color: locked ? '#94a3b8' : selected ? '#f97316' : '#374151',
      size: selected ? 0.095 : 0.055,
      sizeAttenuation: true,
      transparent: true,
      opacity: selected || locked ? 0.95 : 0.58,
    }),
  );
  markers.userData = { kind: 'edge', key, index, role: 'markers' };
  group.add(markers);
  group.userData.line = line;
  group.userData.markers = markers;

  const arrowStep = selected ? 1 : Math.max(1, Math.ceil(points.length / PATH_ARROW_LIMIT));
  points.forEach((point, pointIndex) => {
    const isEndpoint = pointIndex === 0 || pointIndex === points.length - 1;
    if (!selected && !isEndpoint && pointIndex % arrowStep !== 0) return;
    group.add(makeRotationArrow(point, {
      color: locked ? '#94a3b8' : selected ? '#dc2626' : '#0f766e',
      length: selected ? 0.34 : 0.26,
      opacity: selected || isEndpoint ? 0.95 : 0.58,
      zOffset: selected ? 0.11 : 0.075,
    }));
  });

  return group;
}

function pathPointsToPositions(pathPoints = []) {
  const positions = new Float32Array(pathPoints.length * 3);
  pathPoints.forEach((point, index) => {
    const offset = index * 3;
    positions[offset] = Number(point.x) || 0;
    positions[offset + 1] = Number(point.y) || 0;
    positions[offset + 2] = Number(point.z) || 0;
  });
  return positions;
}

function applyPositionsToGeometry(object, positions) {
  if (!object?.geometry) return;
  object.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  object.geometry.computeBoundingSphere();
}

function updateTemporaryPointEdgePreview(drag, position, spacing) {
  if (!drag?.previewVisual || !drag.previewFromNode || !drag.previewToNode || !drag.previewEdge) return;

  const temporaryPoints = drag.previewTemporaryPoints.map((point, index) =>
    index === drag.pointIndex
      ? {
          ...point,
          x: position.x,
          y: position.y,
          z: position.z,
        }
      : point,
  );
  const startSeq = Number.isFinite(Number(drag.previewEdge.path_points?.[0]?.seq))
    ? Number(drag.previewEdge.path_points[0].seq)
    : 1;
  const pathPoints = interpolatePolylinePathPoints(
    [drag.previewFromNode, ...temporaryPoints, drag.previewToNode],
    spacing,
    startSeq,
  );
  const positions = pathPointsToPositions(pathPoints);

  applyPositionsToGeometry(drag.previewVisual.line, positions);
  applyPositionsToGeometry(drag.previewVisual.markers, positions.slice());
}

function getQuantile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const ratio = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - ratio) + sortedValues[upperIndex] * ratio;
}

function getGoalPosesCameraBounds(goalPosesObject) {
  const points = (goalPosesObject?.children || []).map((child) => child.position.clone());
  if (!points.length) return null;

  let cameraPoints = points;
  if (points.length >= 8) {
    const axes = ['x', 'y', 'z'];
    const fences = Object.fromEntries(axes.map((axis) => {
      const values = points.map((point) => point[axis]).sort((first, second) => first - second);
      const lowerQuartile = getQuantile(values, 0.25);
      const upperQuartile = getQuantile(values, 0.75);
      const interquartileRange = upperQuartile - lowerQuartile;
      return [axis, interquartileRange > 0.0001
        ? [lowerQuartile - interquartileRange * 3, upperQuartile + interquartileRange * 3]
        : null];
    }));
    const filtered = points.filter((point) => axes.every((axis) => (
      !fences[axis] || (point[axis] >= fences[axis][0] && point[axis] <= fences[axis][1])
    )));

    if (filtered.length >= Math.max(3, Math.ceil(points.length / 2))) cameraPoints = filtered;
  }

  return new THREE.Box3().setFromPoints(cameraPoints).expandByScalar(GOAL_POSE_RADIUS * 4);
}

function getContentBounds(mapObject, topologyGroup, pathObject, goalPosesObject) {
  const box = new THREE.Box3();
  let hasContent = false;

  if (mapObject) {
    box.expandByObject(mapObject);
    hasContent = true;
  }
  if (topologyGroup?.children.length) {
    box.expandByObject(topologyGroup);
    hasContent = true;
  }
  if (pathObject?.children.length) {
    box.expandByObject(pathObject);
    hasContent = true;
  }
  const goalPosesBounds = getGoalPosesCameraBounds(goalPosesObject);
  if (goalPosesBounds) {
    box.union(goalPosesBounds);
    hasContent = true;
  }

  if (!hasContent || box.isEmpty()) {
    box.setFromCenterAndSize(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 8, 3));
  }

  return box;
}

function getContentCameraMetrics(mapObject, topologyGroup, pathObject, goalPosesObject) {
  const box = getContentBounds(mapObject, topologyGroup, pathObject, goalPosesObject);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 2);

  return { center, maxDim };
}

function applyCameraPose({ camera, controls, center, distance, direction, up }) {
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.01, distance / 1000);
  camera.far = Math.max(1000, distance * 8);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function fitCameraToContent({ camera, controls, mapObject, topologyGroup, pathObject, goalPosesObject }) {
  const { center, maxDim } = getContentCameraMetrics(mapObject, topologyGroup, pathObject, goalPosesObject);
  const distance = maxDim * 1.25;

  applyCameraPose({
    camera,
    controls,
    center,
    distance,
    direction: new THREE.Vector3(1, -1, 0.65).normalize(),
    up: new THREE.Vector3(0, 0, 1),
  });
}

function applyViewFace({ face, camera, controls, mapObject, topologyGroup, pathObject, goalPosesObject }) {
  const preset = VIEW_FACE_PRESETS[face];
  if (!preset) return;

  const { center, maxDim } = getContentCameraMetrics(mapObject, topologyGroup, pathObject, goalPosesObject);
  const distance = maxDim * 1.35;

  applyCameraPose({
    camera,
    controls,
    center,
    distance,
    direction: preset.direction,
    up: preset.up,
  });
}

export default function TopologyViewer({
  mapData,
  topology,
  spacing,
  backgroundColor,
  pointCloudColor,
  pointCloudSize,
  clippingRange,
  pickedPoint,
  pathData,
  pathColor,
  goalPoses,
  selectedNodeId,
  selectedEdgeKey,
  selectedTempPointKey,
  addNodeMode,
  fitNonce,
  viewFaceRequest,
  onNodeSelect,
  onEdgeSelect,
  onTempPointSelect,
  onNodeMoveStart,
  onNodeMove,
  onNodeMoveEnd,
  onTempPointMoveStart,
  onTempPointMoveEnd,
  onAddNodeAt,
  onMapPointPick,
  onPickedPointContextMenu,
}) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const mapObjectRef = useRef(null);
  const pickedPointMarkerRef = useRef(null);
  const pathOverlayRef = useRef(null);
  const goalPosesOverlayRef = useRef(null);
  const topologyGroupRef = useRef(new THREE.Group());
  const nodeMeshesRef = useRef([]);
  const tempPointMeshesRef = useRef([]);
  const edgeObjectsRef = useRef([]);
  const edgeVisualsRef = useRef(new Map());
  const dragRef = useRef(null);
  const propsRef = useRef({
    addNodeMode,
    clippingRange,
    pickedPoint,
    topology,
    spacing,
    onNodeSelect,
    onEdgeSelect,
    onTempPointSelect,
    onNodeMoveStart,
    onNodeMove,
    onNodeMoveEnd,
    onTempPointMoveStart,
    onTempPointMoveEnd,
    onAddNodeAt,
    onMapPointPick,
    onPickedPointContextMenu,
  });

  useEffect(() => {
    propsRef.current = {
      addNodeMode,
      clippingRange,
      pickedPoint,
      topology,
      spacing,
      onNodeSelect,
      onEdgeSelect,
      onTempPointSelect,
      onNodeMoveStart,
      onNodeMove,
      onNodeMoveEnd,
      onTempPointMoveStart,
      onTempPointMoveEnd,
      onAddNodeAt,
      onMapPointPick,
      onPickedPointContextMenu,
    };
  }, [
    addNodeMode,
    clippingRange,
    pickedPoint,
    topology,
    spacing,
    onNodeSelect,
    onEdgeSelect,
    onTempPointSelect,
    onNodeMoveStart,
    onNodeMove,
    onNodeMoveEnd,
    onTempPointMoveStart,
    onTempPointMoveEnd,
    onAddNodeAt,
    onMapPointPick,
    onPickedPointContextMenu,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(backgroundColor || '#0f172a');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
    camera.up.set(0, 0, 1);
    camera.position.set(5, -7, 5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    renderer.localClippingEnabled = true;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    const ambient = new THREE.AmbientLight('#ffffff', 0.72);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight('#ffffff', 0.85);
    directional.position.set(4, -5, 8);
    scene.add(directional);

    const grid = new THREE.GridHelper(40, 40, '#94a3b8', '#d1d5db');
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    scene.add(grid);

    const axes = new THREE.AxesHelper(1.4);
    scene.add(axes);

    const topologyGroup = topologyGroupRef.current;
    scene.add(topologyGroup);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.25;
    raycaster.params.Points.threshold = 0.18;
    const pointer = new THREE.Vector2();
    const plane = new THREE.Plane();
    const planeHit = new THREE.Vector3();
    const offset = new THREE.Vector3();

    const setPointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const getDefaultAddZ = () => {
      const nodes = propsRef.current.topology?.topology_nodes || [];
      if (!nodes.length) return 0;
      return nodes.reduce((sum, node) => sum + (Number(node.z) || 0), 0) / nodes.length;
    };

    const pointerDown = (event) => {
      if (event.button !== 0) return;
      setPointer(event);

      const tempPointHit = raycaster.intersectObjects(tempPointMeshesRef.current, false)[0];
      if (tempPointHit) {
        const group = tempPointHit.object.userData.parentGroup;
        const tempPointSelection = {
          edgeKey: tempPointHit.object.userData.edgeKey,
          edgeIndex: tempPointHit.object.userData.edgeIndex,
          pointIndex: tempPointHit.object.userData.pointIndex,
          key: tempPointHit.object.userData.key,
        };
        if (tempPointHit.object.userData.locked) {
          propsRef.current.onTempPointSelect?.(
            tempPointSelection.edgeKey,
            tempPointSelection.pointIndex,
            tempPointSelection.key,
          );
          return;
        }
        propsRef.current.onTempPointMoveStart?.(
          tempPointSelection.edgeKey,
          tempPointSelection.pointIndex,
        );

        const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
        plane.setFromNormalAndCoplanarPoint(normal, group.position);
        raycaster.ray.intersectPlane(plane, planeHit);
        offset.copy(planeHit).sub(group.position);
        const currentTopology = propsRef.current.topology || {};
        const previewEdge = currentTopology.edges?.[tempPointSelection.edgeIndex];
        const nodesById = new Map((currentTopology.topology_nodes || []).map((node) => [Number(node.id), node]));
        dragRef.current = {
          kind: 'temporaryPoint',
          edgeKey: tempPointSelection.edgeKey,
          pointIndex: tempPointSelection.pointIndex,
          selectionKey: tempPointSelection.key,
          group,
          plane,
          offset: offset.clone(),
          previewEdge,
          previewFromNode: previewEdge ? nodesById.get(Number(previewEdge.from)) : null,
          previewToNode: previewEdge ? nodesById.get(Number(previewEdge.to)) : null,
          previewTemporaryPoints: previewEdge ? getTemporaryPoints(previewEdge) : [],
          previewVisual: edgeVisualsRef.current.get(tempPointSelection.edgeKey),
        };
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }

      const nodeHit = raycaster.intersectObjects(nodeMeshesRef.current, false)[0];
      if (nodeHit) {
        const group = nodeHit.object.userData.parentGroup;
        propsRef.current.onNodeSelect?.(nodeHit.object.userData.id);
        propsRef.current.onEdgeSelect?.(null);
        propsRef.current.onTempPointSelect?.(null, null, null);
        propsRef.current.onNodeMoveStart?.(nodeHit.object.userData.id);

        const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
        plane.setFromNormalAndCoplanarPoint(normal, group.position);
        raycaster.ray.intersectPlane(plane, planeHit);
        offset.copy(planeHit).sub(group.position);
        dragRef.current = { kind: 'node', id: nodeHit.object.userData.id, group, plane, offset: offset.clone() };
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }

      const edgeHit = raycaster.intersectObjects(edgeObjectsRef.current, false)[0];
      if (edgeHit) {
        propsRef.current.onEdgeSelect?.(edgeHit.object.userData.key);
        propsRef.current.onNodeSelect?.(null);
        propsRef.current.onTempPointSelect?.(null, null, null);
        return;
      }

      if (propsRef.current.addNodeMode) {
        const z = getDefaultAddZ();
        plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, z));
        if (raycaster.ray.intersectPlane(plane, planeHit)) {
          propsRef.current.onAddNodeAt?.({ x: planeHit.x, y: planeHit.y, z });
        }
      }
    };

    const doubleClick = (event) => {
      const mapObject = mapObjectRef.current;
      if (!mapObject || propsRef.current.addNodeMode) return;
      const pickedVertex = getNearestScreenPoint(
        mapObject,
        event,
        camera,
        renderer.domElement,
        propsRef.current.clippingRange,
      );
      if (!pickedVertex) return;
      propsRef.current.onMapPointPick?.(pickedVertex);
    };

    const contextMenu = (event) => {
      const pickedPoint = propsRef.current.pickedPoint;
      if (!pickedPoint) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const projected = new THREE.Vector3(pickedPoint.x, pickedPoint.y, pickedPoint.z).project(camera);
      if (projected.z < -1 || projected.z > 1) return;
      const screenX = ((projected.x + 1) / 2) * rect.width;
      const screenY = ((1 - projected.y) / 2) * rect.height;
      const distance = Math.hypot((event.clientX - rect.left) - screenX, (event.clientY - rect.top) - screenY);
      if (distance > 12) return;
      event.preventDefault();
      propsRef.current.onPickedPointContextMenu?.({
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    const pointerMove = (event) => {
      if (!dragRef.current) return;
      setPointer(event);
      if (!raycaster.ray.intersectPlane(dragRef.current.plane, planeHit)) return;
      const next = planeHit.clone().sub(dragRef.current.offset);
      dragRef.current.group.position.copy(next);
      if (dragRef.current.kind === 'temporaryPoint') {
        updateTemporaryPointEdgePreview(dragRef.current, next, propsRef.current.spacing);
        return;
      }
      propsRef.current.onNodeMove?.(dragRef.current.id, {
        x: next.x,
        y: next.y,
        z: next.z,
      });
    };

    const pointerUp = (event) => {
      if (!dragRef.current) return;
      if (dragRef.current.kind === 'temporaryPoint') {
        propsRef.current.onTempPointMoveEnd?.(dragRef.current.edgeKey, dragRef.current.pointIndex, {
          x: dragRef.current.group.position.x,
          y: dragRef.current.group.position.y,
          z: dragRef.current.group.position.z,
        });
        propsRef.current.onTempPointSelect?.(
          dragRef.current.edgeKey,
          dragRef.current.pointIndex,
          dragRef.current.selectionKey,
        );
      } else {
        propsRef.current.onNodeMoveEnd?.(dragRef.current.id, {
          x: dragRef.current.group.position.x,
          y: dragRef.current.group.position.y,
          z: dragRef.current.group.position.z,
        });
      }
      dragRef.current = null;
      controls.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };

    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('dblclick', doubleClick);
    renderer.domElement.addEventListener('contextmenu', contextMenu);

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('dblclick', doubleClick);
      renderer.domElement.removeEventListener('contextmenu', contextMenu);
      controls.dispose();
      disposeObject(topologyGroup);
      if (mapObjectRef.current) disposeObject(mapObjectRef.current);
      if (pickedPointMarkerRef.current) disposeObject(pickedPointMarkerRef.current);
      if (pathOverlayRef.current) disposeObject(pathOverlayRef.current);
      if (goalPosesOverlayRef.current) disposeObject(goalPosesOverlayRef.current);
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.background = new THREE.Color(backgroundColor || '#0f172a');
  }, [backgroundColor]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (mapObjectRef.current) {
      scene.remove(mapObjectRef.current);
      disposeObject(mapObjectRef.current);
      mapObjectRef.current = null;
    }

    if (mapData?.positions?.length) {
      const mapObject = makePointCloud(mapData, {
        color: pointCloudColor,
        size: pointCloudSize,
        clippingPlanes: makeClippingPlanes(clippingRange),
      });
      mapObjectRef.current = mapObject;
      scene.add(mapObject);
    }
  }, [mapData, pointCloudColor, pointCloudSize]);

  useEffect(() => {
    const mapObject = mapObjectRef.current;
    if (!mapObject?.material) return;
    mapObject.material.clippingPlanes = makeClippingPlanes(clippingRange);
    mapObject.material.needsUpdate = true;
  }, [clippingRange]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (pickedPointMarkerRef.current) {
      scene.remove(pickedPointMarkerRef.current);
      disposeObject(pickedPointMarkerRef.current);
      pickedPointMarkerRef.current = null;
    }

    if (!pickedPoint) return;

    const marker = makePickedPointMarker(pickedPoint);
    pickedPointMarkerRef.current = marker;
    scene.add(marker);
  }, [pickedPoint]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (pathOverlayRef.current) {
      scene.remove(pathOverlayRef.current);
      disposeObject(pathOverlayRef.current);
      pathOverlayRef.current = null;
    }

    if (pathData?.positions?.length) {
      const overlay = makePathOverlay(pathData, pathColor);
      pathOverlayRef.current = overlay;
      scene.add(overlay);
    }
  }, [pathData, pathColor]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (goalPosesOverlayRef.current) {
      scene.remove(goalPosesOverlayRef.current);
      disposeObject(goalPosesOverlayRef.current);
      goalPosesOverlayRef.current = null;
    }

    if (goalPoses?.length) {
      const overlay = makeGoalPosesOverlay(goalPoses);
      goalPosesOverlayRef.current = overlay;
      scene.add(overlay);
    }
  }, [goalPoses]);

  useEffect(() => {
    const topologyGroup = topologyGroupRef.current;
    topologyGroup.children.forEach((child) => disposeObject(child));
    topologyGroup.clear();
    nodeMeshesRef.current = [];
    tempPointMeshesRef.current = [];
    edgeObjectsRef.current = [];
    edgeVisualsRef.current.clear();

    (topology.edges || []).forEach((edge, index) => {
      const edgeGroup = makeEdge(edge, index, selectedEdgeKey);
      topologyGroup.add(edgeGroup);
      edgeGroup.children.forEach((child) => edgeObjectsRef.current.push(child));
      edgeVisualsRef.current.set(edgeKey(edge, index), {
        line: edgeGroup.userData.line,
        markers: edgeGroup.userData.markers,
      });

      getTemporaryPoints(edge).forEach((point, pointIndex) => {
        const tempPointGroup = makeTemporaryPoint(edge, index, point, pointIndex, selectedEdgeKey, selectedTempPointKey);
        topologyGroup.add(tempPointGroup);
        const diamond = tempPointGroup.children.find((child) => child.userData.kind === 'temporaryPoint');
        if (diamond) tempPointMeshesRef.current.push(diamond);
      });
    });

    (topology.topology_nodes || []).forEach((node) => {
      const nodeGroup = makeNode(node, selectedNodeId);
      topologyGroup.add(nodeGroup);
      const sphere = nodeGroup.children.find((child) => child.userData.kind === 'node');
      if (sphere) nodeMeshesRef.current.push(sphere);
    });
  }, [topology, selectedNodeId, selectedEdgeKey, selectedTempPointKey]);

  useEffect(() => {
    if (!fitNonce || !cameraRef.current || !controlsRef.current) return;
    requestAnimationFrame(() => {
      fitCameraToContent({
        camera: cameraRef.current,
        controls: controlsRef.current,
        mapObject: mapObjectRef.current,
        topologyGroup: topologyGroupRef.current,
        pathObject: pathOverlayRef.current,
        goalPosesObject: goalPosesOverlayRef.current,
      });
    });
  }, [fitNonce]);

  useEffect(() => {
    if (!viewFaceRequest?.face || !cameraRef.current || !controlsRef.current) return;
    requestAnimationFrame(() => {
      applyViewFace({
        face: viewFaceRequest.face,
        camera: cameraRef.current,
        controls: controlsRef.current,
        mapObject: mapObjectRef.current,
        topologyGroup: topologyGroupRef.current,
        pathObject: pathOverlayRef.current,
        goalPosesObject: goalPosesOverlayRef.current,
      });
    });
  }, [viewFaceRequest]);

  return <div ref={containerRef} className={`viewer-canvas ${addNodeMode ? 'is-placing' : ''}`} />;
}
