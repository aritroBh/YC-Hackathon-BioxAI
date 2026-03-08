import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const TOOLS = [
  { id: "select", icon: "\u25B6", label: "Select" },
  { id: "lasso", icon: "\u2B21", label: "Lasso" },
  { id: "marker", icon: "\u25C8", label: "Marker" },
];

const HYPERSPECIFIC_COLOR_CACHE = new Map();
const MAP_WORLD_PADDING = 6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isRenderableNode(node) {
  return Number.isFinite(node?.umap_x) && Number.isFinite(node?.umap_y);
}

function getZoomLevel(zoom) {
  if (zoom < 18) {
    return "galaxy";
  }
  if (zoom < 40) {
    return "cluster";
  }
  if (zoom < 80) {
    return "node";
  }
  return "detail";
}

function getNodeBaseHex(node) {
  const friction = node.friction_score ?? 0;
  if (friction >= 0.85) {
    return "#ff3050";
  }
  if (friction >= 0.6) {
    return "#ff8c00";
  }
  if (friction >= 0.3) {
    return "#c8e600";
  }
  if (node.polarity === "inhibits") {
    return "#8250ff";
  }
  if (node.polarity === "promotes") {
    return "#00c8ff";
  }
  return "#00e5a0";
}

function hashNodeId(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function hashToUnit(hash) {
  return hash / 0xffffffff;
}

function getHyperspecificColor(node) {
  const baseHex = getNodeBaseHex(node);
  const nodeId = String(node?.node_id ?? "");
  const cacheKey = `${baseHex}:${nodeId}`;
  const cachedColor = HYPERSPECIFIC_COLOR_CACHE.get(cacheKey);

  if (cachedColor) {
    return cachedColor;
  }

  const primaryHash = hashNodeId(nodeId || baseHex);
  const secondaryHash = Math.imul(primaryHash ^ 0x9e3779b9, 2246822519) >>> 0;
  const hueOffset = (hashToUnit(primaryHash) - 0.5) * 0.04;
  const lightnessOffset = (hashToUnit(secondaryHash) - 0.5) * 0.24;
  const color = new THREE.Color(baseHex);

  color.offsetHSL(hueOffset, 0, lightnessOffset);
  HYPERSPECIFIC_COLOR_CACHE.set(cacheKey, color);

  return color;
}

function colorToRgb(color) {
  return [
    clamp(Math.round(color.r * 255), 0, 255),
    clamp(Math.round(color.g * 255), 0, 255),
    clamp(Math.round(color.b * 255), 0, 255),
  ];
}

function offsetColor(color, hueOffset = 0, lightnessOffset = 0) {
  const shifted = color.clone();
  shifted.offsetHSL(hueOffset, 0, lightnessOffset);
  return shifted;
}

function getNodeColor(node) {
  return colorToRgb(getHyperspecificColor(node));
}

function getBaseRadius(node, zoomLevel) {
  switch (zoomLevel) {
    case "galaxy":
      return 2.5;
    case "cluster":
      return 4;
    case "node":
      return 4;
    case "detail":
      return 4;
    default:
      return 4;
  }
}

function getSourceMeta(node) {
  switch (node.source_type) {
    case "private_csv":
      return { label: "Private CSV", color: "#4d7cff" };
    case "pdf_document":
      return { label: "PDF Document", color: "#7aa7ff" };
    case "web_url":
      return { label: "Web URL", color: "#7aa7ff" };
    case "youtube_video":
      return { label: "YouTube", color: "#7aa7ff" };
    default:
      return { label: "Literature", color: "#ffb340" };
  }
}

function formatCategoryLabel(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) {
    return "Uncategorized";
  }

  return normalized
    .split(" ")
    .map((word) => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : ""))
    .join(" ");
}

function getNodeCategoryKey(node) {
  return String(
    node?.subject_type
    || node?.object_type
    || node?.source_type
    || node?.polarity
    || "uncategorized",
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function getCategoryClusterStyle(categoryKey) {
  return {
    boundaryStroke: "rgba(0, 229, 160, 0.35)",
    edgeStroke: "rgba(0, 200, 160, 0.4)",
    labelText: "rgba(255,255,255,0.8)",
    labelBg: "rgba(12,14,18,0.7)",
  };
}

function computeWorldBounds(nodes) {
  const xs = nodes.map((node) => node.umap_x).filter(Number.isFinite);
  const ys = nodes.map((node) => node.umap_y).filter(Number.isFinite);

  if (!xs.length || !ys.length) {
    return null;
  }

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  return {
    xMin,
    xMax,
    yMin,
    yMax,
    spanX: Math.max(1, xMax - xMin),
    spanY: Math.max(1, yMax - yMin),
  };
}

function splitSpatialClusters(nodes, distanceThreshold) {
  if (nodes.length <= 1) {
    return [nodes];
  }

  const thresholdSquared = distanceThreshold * distanceThreshold;
  const pending = new Set(nodes.map((_, index) => index));
  const clusters = [];

  while (pending.size > 0) {
    const seedIndex = pending.values().next().value;
    pending.delete(seedIndex);

    const clusterIndices = [seedIndex];
    const queue = [seedIndex];

    while (queue.length > 0) {
      const currentIndex = queue.pop();
      const currentNode = nodes[currentIndex];
      const matchedIndices = [];

      pending.forEach((candidateIndex) => {
        const candidateNode = nodes[candidateIndex];
        const dx = currentNode.umap_x - candidateNode.umap_x;
        const dy = currentNode.umap_y - candidateNode.umap_y;
        if ((dx * dx) + (dy * dy) <= thresholdSquared) {
          matchedIndices.push(candidateIndex);
        }
      });

      matchedIndices.forEach((candidateIndex) => {
        pending.delete(candidateIndex);
        queue.push(candidateIndex);
        clusterIndices.push(candidateIndex);
      });
    }

    clusters.push(clusterIndices.map((index) => nodes[index]));
  }

  return clusters;
}

function computeCategoryClusters(nodes) {
  const renderableNodes = nodes.filter(isRenderableNode);
  if (!renderableNodes.length) {
    return [];
  }

  const bounds = computeWorldBounds(renderableNodes);
  const proximityThreshold = clamp(
    Math.min(bounds?.spanX ?? 12, bounds?.spanY ?? 12) / 10,
    3.2,
    9.5,
  );
  const groups = new Map();

  renderableNodes.forEach((node) => {
    const categoryKey = getNodeCategoryKey(node);
    const existingGroup = groups.get(categoryKey) ?? [];
    existingGroup.push(node);
    groups.set(categoryKey, existingGroup);
  });

  return Array.from(groups.entries())
    .flatMap(([categoryKey, groupedNodes]) => {
      const categoryLabel = formatCategoryLabel(categoryKey);
      return splitSpatialClusters(groupedNodes, proximityThreshold)
        .filter((clusterNodes) => clusterNodes.length >= 4)
        .map((clusterNodes, index) => {
          const wx = clusterNodes.reduce((sum, node) => sum + node.umap_x, 0) / clusterNodes.length;
          const wy = clusterNodes.reduce((sum, node) => sum + node.umap_y, 0) / clusterNodes.length;
          const averageFriction = clusterNodes.reduce((sum, node) => sum + (node.friction_score ?? 0), 0) / clusterNodes.length;
          const maxFriction = Math.max(...clusterNodes.map((node) => node.friction_score ?? 0));

          return {
            id: `${categoryKey}:${index}`,
            categoryKey,
            label: categoryLabel,
            nodeCount: clusterNodes.length,
            nodes: clusterNodes,
            wx,
            wy,
            averageFriction,
            maxFriction,
          };
        });
    })
    .sort((left, right) => (
      right.nodeCount - left.nodeCount
      || right.maxFriction - left.maxFriction
      || left.label.localeCompare(right.label)
    ));
}

function distanceBetweenPoints(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt((dx * dx) + (dy * dy));
}

function buildMinimumSpanningTreeIndices(nodes) {
  if (nodes.length < 2) {
    return [];
  }

  const visited = new Set([0]);
  const edges = [];

  while (visited.size < nodes.length) {
    let bestEdge = null;

    visited.forEach((fromIndex) => {
      nodes.forEach((toNode, toIndex) => {
        if (visited.has(toIndex)) {
          return;
        }

        const fromNode = nodes[fromIndex];
        const dist = Math.hypot(fromNode.umap_x - toNode.umap_x, fromNode.umap_y - toNode.umap_y);
        if (!bestEdge || dist < bestEdge.dist) {
          bestEdge = { fromIndex, toIndex, dist };
        }
      });
    });

    if (!bestEdge) {
      break;
    }

    visited.add(bestEdge.toIndex);
    edges.push(bestEdge);
  }

  return edges;
}

function buildClusterConstellationEdges(clusters, neighborCount = 3) {
  const edges = new Map();

  clusters.forEach((cluster) => {
    const clusterNodes = cluster.nodes;
    if (clusterNodes.length < 2) {
      return;
    }

    const addEdge = (leftIndex, rightIndex) => {
      if (leftIndex === rightIndex) {
        return;
      }

      const nodeA = clusterNodes[leftIndex];
      const nodeB = clusterNodes[rightIndex];
      const pairKey = [nodeA.node_id, nodeB.node_id].sort().join("::");
      const dist = Math.hypot(nodeA.umap_x - nodeB.umap_x, nodeA.umap_y - nodeB.umap_y);
      const existing = edges.get(pairKey);

      if (!existing || dist < existing.dist) {
        edges.set(pairKey, {
          pairKey,
          clusterId: cluster.id,
          nodeA,
          nodeB,
          dist,
        });
      }
    };

    buildMinimumSpanningTreeIndices(clusterNodes).forEach(({ fromIndex, toIndex }) => {
      addEdge(fromIndex, toIndex);
    });

    clusterNodes.forEach((nodeA, leftIndex) => {
      clusterNodes
        .map((nodeB, rightIndex) => {
          if (leftIndex === rightIndex) {
            return null;
          }

          return {
            rightIndex,
            dist: Math.hypot(nodeA.umap_x - nodeB.umap_x, nodeA.umap_y - nodeB.umap_y),
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.dist - right.dist)
        .slice(0, neighborCount)
        .forEach(({ rightIndex }) => addEdge(leftIndex, rightIndex));
    });
  });

  return Array.from(edges.values());
}

function convexHull(points) {
  if (points.length < 3) {
    return points;
  }

  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  const cross = (origin, a, b) => ((a.x - origin.x) * (b.y - origin.y)) - ((a.y - origin.y) * (b.x - origin.x));
  const lower = [];
  const upper = [];

  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function polygonArea(points) {
  if (points.length < 3) {
    return 0;
  }

  let area = 0;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    area += (points[previous].x * points[index].y) - (points[index].x * points[previous].y);
  }

  return Math.abs(area / 2);
}

function expandHull(points, padding) {
  if (points.length < 3) {
    return points;
  }

  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  return points.map((point) => {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
    return {
      x: point.x + ((dx / dist) * padding),
      y: point.y + ((dy / dist) * padding),
    };
  });
}

function smoothClosedPolygon(points, passes = 1) {
  let current = [...points];

  for (let pass = 0; pass < passes; pass += 1) {
    const next = [];

    for (let index = 0; index < current.length; index += 1) {
      const point = current[index];
      const following = current[(index + 1) % current.length];
      next.push({
        x: (point.x * 0.75) + (following.x * 0.25),
        y: (point.y * 0.75) + (following.y * 0.25),
      });
      next.push({
        x: (point.x * 0.25) + (following.x * 0.75),
        y: (point.y * 0.25) + (following.y * 0.75),
      });
    }

    current = next;
  }

  return current;
}

function simplifyClosedPolygon(points, minDistance) {
  if (points.length < 4) {
    return points;
  }

  const simplified = [];
  points.forEach((point) => {
    const previous = simplified[simplified.length - 1];
    if (!previous || distanceBetweenPoints(previous, point) >= minDistance) {
      simplified.push(point);
    }
  });

  if (simplified.length > 2 && distanceBetweenPoints(simplified[0], simplified[simplified.length - 1]) < minDistance) {
    simplified.pop();
  }

  return simplified.length >= 3 ? simplified : points;
}

function buildAlphaShapeOutline(points, padding) {
  if (points.length < 3) {
    return points;
  }

  if (points.length < 5) {
    return expandHull(convexHull(points), Math.max(4, padding * 0.45));
  }

  const bounds = points.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x),
    maxX: Math.max(acc.maxX, point.x),
    minY: Math.min(acc.minY, point.y),
    maxY: Math.max(acc.maxY, point.y),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });

  let cellSize = clamp(padding * 0.42, 5, 9);
  const influence = Math.max(8, padding * 0.95);
  let cols = Math.max(6, Math.ceil(((bounds.maxX - bounds.minX) + (influence * 2)) / cellSize));
  let rows = Math.max(6, Math.ceil(((bounds.maxY - bounds.minY) + (influence * 2)) / cellSize));

  while ((cols * rows) > 6400) {
    cellSize += 1;
    cols = Math.max(6, Math.ceil(((bounds.maxX - bounds.minX) + (influence * 2)) / cellSize));
    rows = Math.max(6, Math.ceil(((bounds.maxY - bounds.minY) + (influence * 2)) / cellSize));
  }

  const originX = bounds.minX - influence;
  const originY = bounds.minY - influence;
  let occupancy = new Uint8Array(cols * rows);

  points.forEach((point) => {
    const centerCol = Math.floor((point.x - originX) / cellSize);
    const centerRow = Math.floor((point.y - originY) / cellSize);
    const radiusCells = Math.ceil(influence / cellSize);

    for (let row = Math.max(0, centerRow - radiusCells); row <= Math.min(rows - 1, centerRow + radiusCells); row += 1) {
      for (let col = Math.max(0, centerCol - radiusCells); col <= Math.min(cols - 1, centerCol + radiusCells); col += 1) {
        const sampleX = originX + ((col + 0.5) * cellSize);
        const sampleY = originY + ((row + 0.5) * cellSize);
        if (Math.hypot(sampleX - point.x, sampleY - point.y) <= influence) {
          occupancy[(row * cols) + col] = 1;
        }
      }
    }
  });

  for (let pass = 0; pass < 1; pass += 1) {
    const next = occupancy.slice();

    for (let row = 1; row < rows - 1; row += 1) {
      for (let col = 1; col < cols - 1; col += 1) {
        const index = (row * cols) + col;
        if (occupancy[index]) {
          continue;
        }

        let neighbors = 0;
        for (let deltaRow = -1; deltaRow <= 1; deltaRow += 1) {
          for (let deltaCol = -1; deltaCol <= 1; deltaCol += 1) {
            if (!deltaRow && !deltaCol) {
              continue;
            }

            neighbors += occupancy[((row + deltaRow) * cols) + (col + deltaCol)];
          }
        }

        if (neighbors >= 5) {
          next[index] = 1;
        }
      }
    }

    occupancy = next;
  }

  const boundaryPoints = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = (row * cols) + col;
      if (!occupancy[index]) {
        continue;
      }

      let exposed = false;
      for (let deltaRow = -1; deltaRow <= 1 && !exposed; deltaRow += 1) {
        for (let deltaCol = -1; deltaCol <= 1; deltaCol += 1) {
          if (!deltaRow && !deltaCol) {
            continue;
          }

          const nextRow = row + deltaRow;
          const nextCol = col + deltaCol;
          if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols || !occupancy[(nextRow * cols) + nextCol]) {
            exposed = true;
            break;
          }
        }
      }

      if (exposed) {
        boundaryPoints.push({
          x: originX + ((col + 0.5) * cellSize),
          y: originY + ((row + 0.5) * cellSize),
        });
      }
    }
  }

  if (boundaryPoints.length < 4) {
    return expandHull(convexHull(points), Math.max(4, padding * 0.45));
  }

  const centerX = boundaryPoints.reduce((sum, point) => sum + point.x, 0) / boundaryPoints.length;
  const centerY = boundaryPoints.reduce((sum, point) => sum + point.y, 0) / boundaryPoints.length;
  const averageRadius = boundaryPoints.reduce((sum, point) => sum + Math.hypot(point.x - centerX, point.y - centerY), 0) / boundaryPoints.length;
  const sampleCount = clamp(Math.round(Math.sqrt(boundaryPoints.length) * 1.5), 10, 28);
  const angleStep = (Math.PI * 2) / sampleCount;
  let radialSamples = Array.from({ length: sampleCount }, () => null);

  boundaryPoints.forEach((point) => {
    const angle = Math.atan2(point.y - centerY, point.x - centerX);
    const radius = Math.hypot(point.x - centerX, point.y - centerY);
    const normalized = ((angle + Math.PI) / (Math.PI * 2)) * sampleCount;
    const index = ((Math.floor(normalized) % sampleCount) + sampleCount) % sampleCount;
    const sample = radialSamples[index];

    if (!sample || radius > sample.radius) {
      radialSamples[index] = { radius };
    }
  });

  radialSamples = radialSamples.map((sample, index, collection) => {
    if (sample) {
      return sample;
    }

    let previousIndex = (index + collection.length - 1) % collection.length;
    while (!collection[previousIndex] && previousIndex !== index) {
      previousIndex = (previousIndex + collection.length - 1) % collection.length;
    }

    let nextIndex = (index + 1) % collection.length;
    while (!collection[nextIndex] && nextIndex !== index) {
      nextIndex = (nextIndex + 1) % collection.length;
    }

    const previousRadius = collection[previousIndex]?.radius ?? averageRadius;
    const nextRadius = collection[nextIndex]?.radius ?? averageRadius;
    return { radius: (previousRadius + nextRadius) / 2 };
  });

  for (let pass = 0; pass < 2; pass += 1) {
    radialSamples = radialSamples.map((sample, index, collection) => {
      const previous = collection[(index + collection.length - 1) % collection.length];
      const next = collection[(index + 1) % collection.length];
      return {
        radius: Math.max(averageRadius * 0.55, (sample.radius * 0.58) + (((previous.radius + next.radius) / 2) * 0.42)),
      };
    });
  }

  const outline = radialSamples.map((sample, index) => {
    const angle = -Math.PI + (index * angleStep);
    const radius = sample.radius + (padding * 0.18);
    return {
      x: centerX + (Math.cos(angle) * radius),
      y: centerY + (Math.sin(angle) * radius),
    };
  });

  return simplifyClosedPolygon(smoothClosedPolygon(outline, 1), Math.max(4, cellSize * 0.85));
}

function pointInPolygon(px, py, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py))
      && (px < (((xj - xi) * (py - yi)) / ((yj - yi) || 0.00001)) + xi);

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function stableSample(seed, threshold) {
  let hash = 0;
  const text = String(seed ?? "");

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }

  return (Math.abs(hash) % 100) / 100 < threshold;
}

function truncateText(text, maxLength) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\u2026`;
}

const stripHtml = (str) => str?.replace(/<[^>]*>/g, "") ?? "";

function drawGrid(ctx, camera, width, height) {
  const minorSpacing = clamp((36 * camera.zoom) / 18, 28, 92);
  const majorSpacing = minorSpacing * 4;
  const offsetXMinor = ((((camera.x * camera.zoom) + (width / 2)) % minorSpacing) + minorSpacing) % minorSpacing;
  const offsetYMinor = ((((camera.y * camera.zoom) + (height / 2)) % minorSpacing) + minorSpacing) % minorSpacing;
  const offsetXMajor = ((((camera.x * camera.zoom) + (width / 2)) % majorSpacing) + majorSpacing) % majorSpacing;
  const offsetYMajor = ((((camera.y * camera.zoom) + (height / 2)) % majorSpacing) + majorSpacing) % majorSpacing;

  ctx.save();
  ctx.strokeStyle = "rgba(26,31,40,0.55)";
  ctx.lineWidth = 1;

  for (let x = offsetXMinor; x < width; x += minorSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = offsetYMinor; y < height; y += minorSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(42,48,62,0.42)";
  for (let x = offsetXMajor; x < width; x += majorSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = offsetYMajor; y < height; y += majorSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawConstellationEdges(ctx, clusterEdges, projectPoint, canvas) {
  const width = canvas.width;
  const height = canvas.height;

  clusterEdges.forEach((edge) => {
    const { sx: ax, sy: ay } = projectPoint(edge.nodeA, canvas);
    const { sx: bx, sy: by } = projectPoint(edge.nodeB, canvas);

    if ((ax < -50 && bx < -50) || (ax > width + 50 && bx > width + 50) || (ay < -50 && by < -50) || (ay > height + 50 && by > height + 50)) {
      return;
    }

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0, 200, 160, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
  });
}

function drawContradictionEdges(ctx, nodes, nodeMap, selectedIdSet, worldToScreen, canvas, zoom) {
  const drawnPairs = new Set();
  const width = canvas.width;
  const height = canvas.height;
  const zoomLevel = getZoomLevel(zoom);

  nodes.forEach((node) => {
    if (!node.contradicting_node_ids?.length) {
      return;
    }

    const { sx: ax, sy: ay } = worldToScreen(node.umap_x, node.umap_y, canvas);

    node.contradicting_node_ids.forEach((contraId) => {
      const pairKey = [node.node_id, contraId].sort().join("::");
      if (drawnPairs.has(pairKey)) {
        return;
      }
      drawnPairs.add(pairKey);

      const contra = nodeMap[contraId];
      if (!contra || contra.umap_x == null || contra.umap_y == null) {
        return;
      }

      const { sx: bx, sy: by } = worldToScreen(contra.umap_x, contra.umap_y, canvas);
      if ((ax < -80 && bx < -80) || (ax > width + 80 && bx > width + 80) || (ay < -80 && by < -80) || (ay > height + 80 && by > height + 80)) {
        return;
      }

      const isHighlighted = selectedIdSet.has(node.node_id) || selectedIdSet.has(contraId);
      const friction = Math.max(node.friction_score ?? 0, contra.friction_score ?? 0);
      let red = 0;
      let green = 229;
      let blue = 160;

      if (friction >= 0.85) {
        red = 255;
        green = 48;
        blue = 80;
      } else if (friction >= 0.6) {
        red = 255;
        green = 140;
        blue = 0;
      }

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);

      if (isHighlighted) {
        ctx.strokeStyle = `rgba(${red},${green},${blue},0.7)`;
        ctx.lineWidth = zoomLevel === "detail" ? 1.8 : 1.5;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = `rgba(${red},${green},${blue},0.12)`;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 5]);
      }

      ctx.stroke();
      ctx.setLineDash([]);
    });
  });
}

function projectCategoryClusterOverlay(cluster, canvas, viewMode, zoom, worldToScreen, project3D) {
  const screenPoints = cluster.nodes
    .map((node) => {
      if (viewMode === "3D") {
        const projected = project3D(node.umap_x, node.umap_y, 0, canvas);
        return { x: projected.sx, y: projected.sy };
      }

      const { sx, sy } = worldToScreen(node.umap_x, node.umap_y, canvas);
      return { x: sx, y: sy };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (screenPoints.length < 3) {
    return null;
  }

  const padding = viewMode === "3D"
    ? 14
    : clamp(8 + (zoom / 32), 8, 14);
  const hull = buildAlphaShapeOutline(screenPoints, padding);
  const area = polygonArea(hull);
  const bounds = hull.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x),
    maxX: Math.max(acc.maxX, point.x),
    minY: Math.min(acc.minY, point.y),
    maxY: Math.max(acc.maxY, point.y),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
  const offscreen = (
    bounds.maxX < -120
    || bounds.minX > canvas.width + 120
    || bounds.maxY < -120
    || bounds.minY > canvas.height + 120
  );
  const labelProjection = viewMode === "3D"
    ? project3D(cluster.wx, cluster.wy, 0, canvas)
    : worldToScreen(cluster.wx, cluster.wy, canvas);

  return {
    ...cluster,
    hull,
    area,
    offscreen,
    label: {
      text: cluster.label,
      originSx: labelProjection.sx,
      originSy: labelProjection.sy,
      sx: labelProjection.sx,
      sy: labelProjection.sy,
      scale: 1,
      visible: !offscreen && area >= 80,
      depth: labelProjection.depth ?? 0,
    },
  };
}

function drawCategoryClusterOverlays(ctx, projectedClusters, zoomLevel, viewMode) {
  projectedClusters.forEach((cluster) => {
    if (!cluster || cluster.offscreen || cluster.hull.length < 3) {
      return;
    }

    const style = getCategoryClusterStyle(cluster.categoryKey);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cluster.hull[0].x, cluster.hull[0].y);
    cluster.hull.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = style.boundaryStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();
  });
}

function abbreviateClusterLabel(label) {
  const words = String(label ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) {
    return label;
  }

  return `${words.slice(0, 2).join(" ")}…`;
}

function layoutClusterLabels(projectedClusters, ctx, canvas, zoomScale) {
  const fontSize = zoomScale < 0.6
    ? 9
    : zoomScale > 2
      ? 14
      : 11;
  const showPill = zoomScale >= 0.6;
  const inset = 12;
  const entries = projectedClusters
    .filter((cluster) => cluster?.label?.visible)
    .map((cluster) => ({
      id: cluster.id,
      cluster,
      originX: cluster.label.originSx,
      originY: cluster.label.originSy,
      x: cluster.label.originSx,
      y: cluster.label.originSy,
      text: cluster.label.text,
      fontSize,
      showPill,
      width: 0,
      height: 0,
    }));

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      const centerDistance = Math.hypot(left.originX - right.originX, left.originY - right.originY);

      if (centerDistance < 80) {
        const shortenLeft = left.text.length <= right.text.length;
        if (shortenLeft) {
          left.text = abbreviateClusterLabel(left.text);
        } else {
          right.text = abbreviateClusterLabel(right.text);
        }
      }
    }
  }

  ctx.save();
  entries.forEach((entry) => {
    ctx.font = `500 ${entry.fontSize}px Syne`;
    const measuredWidth = ctx.measureText(entry.text).width;
    entry.width = measuredWidth + (entry.showPill ? 8 : 0);
    entry.height = entry.fontSize + (entry.showPill ? 8 : 0);
  });
  ctx.restore();

  const clampEntry = (entry) => {
    entry.x = clamp(entry.x, inset + (entry.width / 2), canvas.width - inset - (entry.width / 2));
    entry.y = clamp(entry.y, inset + (entry.height / 2), canvas.height - inset - (entry.height / 2));
  };

  entries.forEach(clampEntry);

  for (let iteration = 0; iteration < 30; iteration += 1) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const left = entries[leftIndex];
        const right = entries[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const overlapX = ((left.width + right.width) / 2) + 8 - Math.abs(dx);
        const overlapY = ((left.height + right.height) / 2) + 8 - Math.abs(dy);

        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        let pushX = right.originX - left.originX;
        let pushY = right.originY - left.originY;

        if (Math.abs(pushX) < 0.001 && Math.abs(pushY) < 0.001) {
          pushX = dx || 1;
          pushY = dy || 0;
        }

        const length = Math.hypot(pushX, pushY) || 1;
        const pushDistance = (Math.min(overlapX, overlapY) + 8) / 2;
        const offsetX = (pushX / length) * pushDistance;
        const offsetY = (pushY / length) * pushDistance;

        left.x -= offsetX;
        left.y -= offsetY;
        right.x += offsetX;
        right.y += offsetY;

        clampEntry(left);
        clampEntry(right);
      }
    }
  }

  const layoutById = new Map(entries.map((entry) => [entry.id, entry]));

  return projectedClusters.map((cluster) => {
    if (!cluster?.label?.visible) {
      return cluster;
    }

    const layout = layoutById.get(cluster.id);
    if (!layout) {
      return cluster;
    }

    const displacement = Math.hypot(layout.x - layout.originX, layout.y - layout.originY);

    return {
      ...cluster,
      label: {
        ...cluster.label,
        text: layout.text,
        sx: layout.x,
        sy: layout.y,
        width: layout.width,
        height: layout.height,
        fontSize: layout.fontSize,
        showPill: layout.showPill,
        showLeader: displacement > 20,
      },
    };
  });
}

function drawClusterLabelConnectors(ctx, projectedClusters) {
  ctx.save();
  ctx.strokeStyle = "#3a4055";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  projectedClusters.forEach((cluster) => {
    if (!cluster?.label?.visible || !cluster.label.showLeader) {
      return;
    }

    ctx.beginPath();
    ctx.moveTo(cluster.label.originSx, cluster.label.originSy);
    ctx.lineTo(cluster.label.sx, cluster.label.sy);
    ctx.stroke();
  });

  ctx.setLineDash([]);
  ctx.restore();
}

function drawNode(ctx, node, sx, sy, zoom, isSelected, isHovered, viewMode, isScoutFlagged, scoutHighlightColor) {
  const zoomLevel = getZoomLevel(zoom);
  const friction = node.friction_score ?? 0;
  const baseColor = getHyperspecificColor(node);
  const [red, green, blue] = colorToRgb(baseColor);
  const [rimRed, rimGreen, rimBlue] = colorToRgb(offsetColor(baseColor, 0.008, 0.12));
  let drawX = sx;
  let drawY = sy;
  let scaleMult = 1;

  if (viewMode === "3D" && node.proj) {
    drawX = node.proj.sx;
    drawY = node.proj.sy;
    scaleMult = node.proj.scale;
  }

  const baseRadius = getBaseRadius(node, zoomLevel) * scaleMult;

  if (viewMode === "3D" && node.proj?.groundSx != null && node.proj?.groundSy != null) {
    ctx.beginPath();
    ctx.moveTo(node.proj.groundSx, node.proj.groundSy);
    ctx.lineTo(drawX, drawY);
    ctx.strokeStyle = `rgba(${red},${green},${blue},${0.14 + (friction * 0.12)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.shadowColor = `rgba(${red}, ${green}, ${blue}, ${0.1 + (friction * 0.1)})`;
    ctx.shadowBlur = 4 + (friction * 4);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(1, 2 * scaleMult);
  } else if (viewMode === "2.5D") {
    ctx.shadowColor = `rgba(${red}, ${green}, ${blue}, ${0.12 + (friction * 0.12)})`;
    ctx.shadowBlur = 5 + (friction * 5);
    ctx.shadowOffsetX = 2 * scaleMult;
    ctx.shadowOffsetY = (3 + (friction * 4)) * scaleMult;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  ctx.beginPath();
  ctx.arc(drawX, drawY, baseRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${red},${green},${blue})`;
  ctx.fill();

  if (zoomLevel !== "galaxy") {
    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rimRed},${rimGreen},${rimBlue},0.35)`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  if (node.source_type !== "public_abstract" && zoomLevel !== "galaxy") {
    const size = baseRadius * 1.25;
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.52)`;
    ctx.lineWidth = 0.7;
    ctx.strokeRect(drawX - (size / 2), drawY - (size / 2), size, size);
  }

  if (isSelected) {
    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.3)`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  if (isScoutFlagged) {
    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius + 10, 0, Math.PI * 2);
    ctx.strokeStyle = scoutHighlightColor;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = scoutHighlightColor;
    ctx.font = "bold 9px 'DM Mono'";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("◈", drawX, drawY - baseRadius - 8);
  }

  if (isHovered && !isSelected) {
    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.5)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function drawLasso(ctx, points) {
  if (points.length < 2) {
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.strokeStyle = "rgba(0,229,160,0.8)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(0,229,160,0.05)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,229,160,0.6)";
  ctx.fill();
}

function drawMarkers(ctx, markers, projectPoint, canvas) {
  markers.forEach((marker) => {
    const { sx, sy } = projectPoint(marker.wx, marker.wy, canvas);
    const size = 8;

    ctx.beginPath();
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx + size, sy);
    ctx.lineTo(sx, sy + size);
    ctx.lineTo(sx - size, sy);
    ctx.closePath();
    ctx.fillStyle = "#ffb340";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,179,64,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (marker.label) {
      ctx.font = "11px 'DM Mono', monospace";
      const metrics = ctx.measureText(marker.label);
      ctx.fillStyle = "rgba(5,6,8,0.85)";
      ctx.fillRect(sx - (metrics.width / 2) - 4, sy - size - 18, metrics.width + 8, 16);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(marker.label, sx, sy - size - 2);
    }
  });
}

const MapCanvas = forwardRef(function MapCanvas({
  nodes = [],
  allNodes = nodes,
  selectedIds = [],
  viewMode = "2D",
  scoutHighlightIds = [],
  scoutHighlightColor = "#ffff00",
  onSelectNode,
  onMultiSelect,
  onHoverNode,
  onNodeInspect,
}, ref) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const minimapRef = useRef(null);
  const cameraRef = useRef({
    x: 0,
    y: 0,
    zoom: 1,
    baseZoom: 1,
    zoomScale: 1,
    pitch: 0.8,
    yaw: 0.5,
  });
  const animationRef = useRef(null);
  const edgeRenderResumeAtRef = useRef(0);
  const isDragging = useRef(false);
  const dragStart = useRef(null);
  const dragMoved = useRef(false);
  const lastClickRef = useRef({ time: 0, nodeId: null });
  const isLassoDrawing = useRef(false);
  const lassoPointsRef = useRef([]);
  const clusterLabelRefs = useRef(new Map());
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState("select");
  const [coloringOpen, setColoringOpen] = useState(true);
  const [markers, setMarkers] = useState([]);
  const [markerInput, setMarkerInput] = useState(null);
  const [lassoPoints, setLassoPoints] = useState([]);
  const [isDraggingVisual, setIsDraggingVisual] = useState(false);

  const handleCanvasRef = useCallback((element) => {
    canvasRef.current = element;

    if (typeof ref === "function") {
      ref(element);
      return;
    }

    if (ref) {
      ref.current = element;
    }
  }, [ref]);

  const renderableNodes = useMemo(
    () => nodes.filter(isRenderableNode),
    [nodes],
  );

  const allRenderableNodes = useMemo(
    () => allNodes.filter(isRenderableNode),
    [allNodes],
  );

  const worldBounds = useMemo(
    () => computeWorldBounds(renderableNodes),
    [renderableNodes],
  );

  const categoryClusters = useMemo(
    () => computeCategoryClusters(renderableNodes),
    [renderableNodes],
  );

  const clusterEdges = useMemo(
    () => buildClusterConstellationEdges(categoryClusters, 3),
    [categoryClusters],
  );

  const nodeMap = useMemo(
    () => Object.fromEntries(allRenderableNodes.map((node) => [node.node_id, node])),
    [allRenderableNodes],
  );

  const selectedIdSet = useMemo(
    () => new Set(selectedIds),
    [selectedIds],
  );

  const scoutHighlightIdSet = useMemo(
    () => new Set(scoutHighlightIds),
    [scoutHighlightIds],
  );

  const pointColoringItems = useMemo(
    () => [
      ["#ff3050", "Critical \u2265 0.85", nodes.filter((node) => (node.friction_score ?? 0) >= 0.85).length],
      ["#ff8c00", "High \u2265 0.60", nodes.filter((node) => (node.friction_score ?? 0) >= 0.6 && (node.friction_score ?? 0) < 0.85).length],
      ["#c8e600", "Medium \u2265 0.30", nodes.filter((node) => (node.friction_score ?? 0) >= 0.3 && (node.friction_score ?? 0) < 0.6).length],
      ["#8250ff", "Inhibits (low)", nodes.filter((node) => (node.friction_score ?? 0) < 0.3 && node.polarity === "inhibits").length],
      ["#00c8ff", "Promotes (low)", nodes.filter((node) => (node.friction_score ?? 0) < 0.3 && node.polarity === "promotes").length],
      ["#00e5a0", "Neutral", nodes.filter((node) => (node.friction_score ?? 0) < 0.3 && node.polarity !== "inhibits" && node.polarity !== "promotes").length],
    ],
    [nodes],
  );

  useEffect(() => {
    lassoPointsRef.current = lassoPoints;
  }, [lassoPoints]);

  useEffect(() => {
    if (hoveredNode && !nodeMap[hoveredNode.node_id]) {
      setHoveredNode(null);
      onHoverNode?.(null);
    }
  }, [hoveredNode, nodeMap, onHoverNode]);

  const registerClusterLabelRef = useCallback((clusterId, element) => {
    if (element) {
      clusterLabelRefs.current.set(clusterId, element);
      return;
    }

    clusterLabelRefs.current.delete(clusterId);
  }, []);

  const syncClusterLabelPositions = useCallback((projectedClusters) => {
    const refs = clusterLabelRefs.current;
    const visibleIds = new Set();

    projectedClusters.forEach((cluster) => {
      const element = refs.get(cluster.id);
      if (!element) {
        return;
      }

      visibleIds.add(cluster.id);

      if (!cluster.label.visible) {
        element.style.opacity = "0";
        element.style.transform = "translate(-9999px, -9999px)";
        return;
      }

      const pill = element.firstElementChild;
      const text = pill?.firstElementChild;
      if (pill) {
        pill.style.padding = cluster.label.showPill ? "4px" : "0";
        pill.style.borderRadius = cluster.label.showPill ? "4px" : "0";
        pill.style.background = cluster.label.showPill ? "rgba(12,14,18,0.7)" : "transparent";
      }
      if (text) {
        if (text.textContent !== cluster.label.text) {
          text.textContent = cluster.label.text;
        }
        text.style.fontSize = `${cluster.label.fontSize}px`;
      }

      element.style.opacity = "1";
      element.style.transform = `translate(${cluster.label.sx}px, ${cluster.label.sy}px) translate(-50%, -50%)`;
    });

    refs.forEach((element, clusterId) => {
      if (visibleIds.has(clusterId)) {
        return;
      }

      element.style.opacity = "0";
      element.style.transform = "translate(-9999px, -9999px)";
    });
  }, []);

  const suspendClusterEdgeRendering = useCallback((delayMs = 150) => {
    edgeRenderResumeAtRef.current = performance.now() + delayMs;
  }, []);

  const worldToScreen = useCallback((wx, wy, canvas) => {
    const camera = cameraRef.current;
    return {
      sx: (canvas.width / 2) + ((wx + camera.x) * camera.zoom),
      sy: (canvas.height / 2) + ((wy + camera.y) * camera.zoom),
    };
  }, []);

  const project3D = useCallback((wx, wy, wz, canvas) => {
    const camera = cameraRef.current;
    let dx = wx + camera.x;
    let dy = wy + camera.y;
    const dz = wz;

    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const rx = dx * cosYaw - dy * sinYaw;
    const ry = dx * sinYaw + dy * cosYaw;

    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const rz = ry * sinPitch + dz * cosPitch;
    const finalY = ry * cosPitch - dz * sinPitch;

    const fov = 800;
    const scale = clamp(fov / (fov + (rz * 10)), 0.35, 2.4);

    return {
      sx: (canvas.width / 2) + (rx * camera.zoom * scale),
      sy: (canvas.height / 2) + (finalY * camera.zoom * scale),
      scale,
      depth: rz,
    };
  }, []);

  const getScreenRelativeWorld = useCallback((sx, sy, canvas, cameraOverride = cameraRef.current) => {
    if (viewMode !== "3D") {
      return {
        dx: (sx - (canvas.width / 2)) / cameraOverride.zoom,
        dy: (sy - (canvas.height / 2)) / cameraOverride.zoom,
      };
    }

    const x = sx - (canvas.width / 2);
    const y = sy - (canvas.height / 2);
    const cosPitch = Math.cos(cameraOverride.pitch);
    const sinPitch = Math.sin(cameraOverride.pitch);
    const fov = 800;
    const denominator = (cosPitch * cameraOverride.zoom * fov) - (y * 10 * sinPitch);
    const ry = Math.abs(denominator) < 0.0001
      ? 0
      : (y * fov) / denominator;
    const scale = fov / (fov + (ry * sinPitch * 10));
    const rx = x / ((cameraOverride.zoom * scale) || 1);
    const cosYaw = Math.cos(cameraOverride.yaw);
    const sinYaw = Math.sin(cameraOverride.yaw);

    return {
      dx: (rx * cosYaw) + (ry * sinYaw),
      dy: (-rx * sinYaw) + (ry * cosYaw),
    };
  }, [viewMode]);

  const projectNode = useCallback((node, canvas) => {
    if (viewMode === "3D") {
      const ground = project3D(node.umap_x, node.umap_y, 0, canvas);
      const elevated = project3D(node.umap_x, node.umap_y, (node.friction_score ?? 0) * 40, canvas);
      return {
        ...elevated,
        groundSx: ground.sx,
        groundSy: ground.sy,
        groundScale: ground.scale,
      };
    }

    const { sx, sy } = worldToScreen(node.umap_x, node.umap_y, canvas);
    return {
      sx,
      sy,
      scale: 1,
      depth: 0,
    };
  }, [project3D, viewMode, worldToScreen]);

  const screenToWorld = useCallback((sx, sy, canvas) => {
    const camera = cameraRef.current;
    const { dx, dy } = getScreenRelativeWorld(sx, sy, canvas, camera);
    return {
      wx: dx - camera.x,
      wy: dy - camera.y,
    };
  }, [getScreenRelativeWorld]);

  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    setViewport((current) => (
      current.width === width && current.height === height
        ? current
        : { width, height }
    ));
  }, []);

  useEffect(() => {
    syncCanvasSize();
    if (!wrapperRef.current || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => syncCanvasSize());
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [syncCanvasSize]);

  const fitToView = useCallback((paddingPx = 60) => {
    if (!renderableNodes.length) {
      return;
    }

    syncCanvasSize();
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const xs = renderableNodes.map((node) => node.umap_x).filter(Number.isFinite);
    const ys = renderableNodes.map((node) => node.umap_y).filter(Number.isFinite);
    if (!xs.length || !ys.length) {
      return;
    }

    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const worldW = Math.max(1, xMax - xMin);
    const worldH = Math.max(1, yMax - yMin);
    const availableWidth = Math.max(1, canvas.width - (paddingPx * 2));
    const availableHeight = Math.max(1, canvas.height - (paddingPx * 2));
    const fitZoom = Math.min(availableWidth / worldW, availableHeight / worldH);
    const centerX = (xMin + xMax) / 2;
    const centerY = (yMin + yMax) / 2;

    cameraRef.current = {
      x: -centerX,
      y: -centerY,
      zoom: fitZoom,
      baseZoom: fitZoom,
      zoomScale: 1,
      pitch: cameraRef.current.pitch ?? 0.8,
      yaw: cameraRef.current.yaw ?? 0.5,
    };
    suspendClusterEdgeRendering();
  }, [renderableNodes, suspendClusterEdgeRendering, syncCanvasSize]);

  useEffect(() => {
    fitToView(60);
  }, [fitToView]);

  const applyZoomAtPoint = useCallback((nextZoomScale, point, canvas) => {
    const camera = cameraRef.current;
    const clampedZoomScale = clamp(nextZoomScale, 0.4, 4);
    const { dx: beforeDx, dy: beforeDy } = getScreenRelativeWorld(point.x, point.y, canvas, camera);
    const worldX = beforeDx - camera.x;
    const worldY = beforeDy - camera.y;

    camera.zoomScale = clampedZoomScale;
    camera.zoom = camera.baseZoom * camera.zoomScale;

    const { dx: afterDx, dy: afterDy } = getScreenRelativeWorld(point.x, point.y, canvas, camera);
    camera.x = afterDx - worldX;
    camera.y = afterDy - worldY;
    suspendClusterEdgeRendering();
  }, [getScreenRelativeWorld, suspendClusterEdgeRendering]);

  const clientToCanvasPoint = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const pickNode = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    const point = clientToCanvasPoint(clientX, clientY);
    if (!canvas || !point) {
      return null;
    }

    const zoomLevel = getZoomLevel(cameraRef.current.zoom);
    let closestNode = null;
    let minDistance = Number.POSITIVE_INFINITY;

    renderableNodes.forEach((node) => {
      const { sx, sy, scale } = projectNode(node, canvas);
      const distance = Math.hypot(sx - point.x, sy - point.y);
      const threshold = (getBaseRadius(node, zoomLevel) * scale) + (zoomLevel === "galaxy" ? 8 : 10);

      if (distance <= threshold && distance < minDistance) {
        closestNode = node;
        minDistance = distance;
      }
    });

    return closestNode;
  }, [clientToCanvasPoint, projectNode, renderableNodes]);

  const drawMinimap = useCallback(() => {
    const minimapCanvas = minimapRef.current;
    if (!minimapCanvas || !renderableNodes.length || !worldBounds) {
      return;
    }

    const minimapCtx = minimapCanvas.getContext("2d");
    if (!minimapCtx) {
      return;
    }

    minimapCanvas.width = 160;
    minimapCanvas.height = 120;
    minimapCtx.fillStyle = "#080a0e";
    minimapCtx.fillRect(0, 0, 160, 120);
    minimapCtx.strokeStyle = "#1e2430";
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(0, 0, 160, 120);
 
    const wxMin = worldBounds.xMin - MAP_WORLD_PADDING;
    const wxMax = worldBounds.xMax + MAP_WORLD_PADDING;
    const wyMin = worldBounds.yMin - MAP_WORLD_PADDING;
    const wyMax = worldBounds.yMax + MAP_WORLD_PADDING;
    const scaleX = 148 / Math.max(1, wxMax - wxMin);
    const scaleY = 108 / Math.max(1, wyMax - wyMin);

    renderableNodes.forEach((node) => {
      const mx = 6 + ((node.umap_x - wxMin) * scaleX);
      const my = 6 + ((node.umap_y - wyMin) * scaleY);
      const [red, green, blue] = getNodeColor(node);

      minimapCtx.beginPath();
      minimapCtx.arc(mx, my, 1.5, 0, Math.PI * 2);
      minimapCtx.fillStyle = `rgba(${red},${green},${blue},0.7)`;
      minimapCtx.fill();
    });

    const mainCanvas = canvasRef.current;
    if (!mainCanvas) {
      return;
    }

    const camera = cameraRef.current;
    const viewportWidth = mainCanvas.width / camera.zoom;
    const viewportHeight = mainCanvas.height / camera.zoom;
    const viewportX = -camera.x - (viewportWidth / 2);
    const viewportY = -camera.y - (viewportHeight / 2);
    const minimapViewportX = 6 + ((viewportX - wxMin) * scaleX);
    const minimapViewportY = 6 + ((viewportY - wyMin) * scaleY);
    const minimapViewportWidth = viewportWidth * scaleX;
    const minimapViewportHeight = viewportHeight * scaleY;

    minimapCtx.strokeStyle = "rgba(0,229,160,0.6)";
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(
      minimapViewportX,
      minimapViewportY,
      minimapViewportWidth,
      minimapViewportHeight,
    );
    minimapCtx.fillStyle = "rgba(0,229,160,0.05)";
    minimapCtx.fillRect(
      minimapViewportX,
      minimapViewportY,
      minimapViewportWidth,
      minimapViewportHeight,
    );
  }, [renderableNodes, worldBounds]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    syncCanvasSize();
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    const zoom = cameraRef.current.zoom;
    const zoomScale = cameraRef.current.zoomScale ?? 1;
    const zoomLevel = getZoomLevel(zoom);
    const projectedCategoryClusters = categoryClusters
      .map((cluster) => projectCategoryClusterOverlay(
        cluster,
        canvas,
        viewMode,
        zoom,
        worldToScreen,
        project3D,
      ))
      .filter(Boolean);
    const laidOutCategoryClusters = layoutClusterLabels(projectedCategoryClusters, ctx, canvas, zoomScale);
    const shouldRenderClusterEdges = !isDragging.current && performance.now() >= edgeRenderResumeAtRef.current;

    ctx.fillStyle = "#050608";
    ctx.fillRect(0, 0, width, height);

    drawCategoryClusterOverlays(ctx, laidOutCategoryClusters, zoomLevel, viewMode);
    drawClusterLabelConnectors(ctx, laidOutCategoryClusters);
    syncClusterLabelPositions(laidOutCategoryClusters);

    if (zoomLevel !== "galaxy" && shouldRenderClusterEdges) {
      drawConstellationEdges(ctx, clusterEdges, projectNode, canvas);
    }

    if (viewMode !== "3D") {
      drawContradictionEdges(ctx, renderableNodes, nodeMap, selectedIdSet, worldToScreen, canvas, zoom);
    }

    if (tool === "lasso" && lassoPoints.length > 1) {
      drawLasso(ctx, lassoPoints);
    }

    let renderNodes = renderableNodes;
    if (viewMode === "3D") {
      renderNodes = renderableNodes
        .map((node) => ({ ...node, proj: projectNode(node, canvas) }))
        .sort((left, right) => right.proj.depth - left.proj.depth);
    }

    let hoveredRenderableNode = null;

    renderNodes.forEach((node) => {
      const { sx, sy } = node.proj ?? projectNode(node, canvas);
      if (sx < -30 || sx > width + 30 || sy < -30 || sy > height + 30) {
        return;
      }

      if (hoveredNode?.node_id === node.node_id) {
        hoveredRenderableNode = node;
        return;
      }

      drawNode(
        ctx,
        node,
        sx,
        sy,
        zoom,
        selectedIdSet.has(node.node_id),
        false,
        viewMode,
        scoutHighlightIdSet.has(node.node_id),
        scoutHighlightColor,
      );
    });

    if (hoveredRenderableNode) {
      const { sx, sy } = hoveredRenderableNode.proj ?? projectNode(hoveredRenderableNode, canvas);
      drawNode(
        ctx,
        hoveredRenderableNode,
        sx,
        sy,
        zoom,
        selectedIdSet.has(hoveredRenderableNode.node_id),
        true,
        viewMode,
        scoutHighlightIdSet.has(hoveredRenderableNode.node_id),
        scoutHighlightColor,
      );
    }

    const projectMarker = viewMode === "3D"
      ? (wx, wy, currentCanvas) => project3D(wx, wy, 0, currentCanvas)
      : worldToScreen;

    drawMarkers(ctx, markers, projectMarker, canvas);
    drawMinimap();
  }, [
    categoryClusters,
    drawMinimap,
    hoveredNode,
    lassoPoints,
    markers,
    clusterEdges,
    nodeMap,
    project3D,
    projectNode,
    renderableNodes,
    scoutHighlightColor,
    scoutHighlightIdSet,
    selectedIdSet,
    syncClusterLabelPositions,
    syncCanvasSize,
    tool,
    viewMode,
    worldToScreen,
  ]);

  useEffect(() => {
    const animate = () => {
      draw();
      animationRef.current = window.requestAnimationFrame(animate);
    };

    animationRef.current = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationRef.current);
  }, [draw]);

  const handlePointerMove = useCallback((event) => {
    if (tool === "lasso" && isLassoDrawing.current) {
      const point = clientToCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      const previousPoint = lassoPointsRef.current[lassoPointsRef.current.length - 1];
      if (!previousPoint || Math.hypot(previousPoint.x - point.x, previousPoint.y - point.y) >= 2) {
        const nextPoints = [...lassoPointsRef.current, point];
        lassoPointsRef.current = nextPoints;
        setLassoPoints(nextPoints);
      }
      return;
    }

    if (isDragging.current && dragStart.current) {
      const camera = cameraRef.current;
      const deltaX = event.clientX - dragStart.current.x;
      const deltaY = event.clientY - dragStart.current.y;

      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        dragMoved.current = true;
      }

      if (viewMode === "3D") {
        camera.yaw -= deltaX * 0.01;
        camera.pitch += deltaY * 0.01;
        camera.pitch = clamp(camera.pitch, 0, Math.PI / 2.2);
      } else {
        camera.x += deltaX / camera.zoom;
        camera.y += deltaY / camera.zoom;
      }
      suspendClusterEdgeRendering();
      dragStart.current = { x: event.clientX, y: event.clientY };
      return;
    }

    const hit = pickNode(event.clientX, event.clientY);
    setHoveredNode(hit);
    onHoverNode?.(hit);

    if (hit) {
      setTooltipPos({ x: event.clientX + 14, y: event.clientY - 10 });
    }
  }, [clientToCanvasPoint, onHoverNode, pickNode, suspendClusterEdgeRendering, tool, viewMode]);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }

    setMarkerInput(null);

    if (tool === "lasso") {
      const point = clientToCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      event.preventDefault();
      isLassoDrawing.current = true;
      lassoPointsRef.current = [point];
      setLassoPoints([point]);
      setHoveredNode(null);
      onHoverNode?.(null);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    if (tool === "marker") {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    isDragging.current = true;
    dragMoved.current = false;
    dragStart.current = { x: event.clientX, y: event.clientY };
    setIsDraggingVisual(true);
    suspendClusterEdgeRendering();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [clientToCanvasPoint, onHoverNode, suspendClusterEdgeRendering, tool]);

  const handlePointerUp = useCallback((event) => {
    if (tool === "lasso" && isLassoDrawing.current) {
      isLassoDrawing.current = false;
      const canvas = canvasRef.current;
      const captured = lassoPointsRef.current;

      if (canvas && captured.length > 3) {
        const inside = renderableNodes
          .filter((node) => {
            const { sx, sy } = projectNode(node, canvas);
            return pointInPolygon(sx, sy, captured);
          })
          .map((node) => node.node_id);

        if (inside.length > 0) {
          onMultiSelect?.(inside);
        }
      }

      lassoPointsRef.current = [];
      setLassoPoints([]);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }

    if (tool === "marker") {
      const canvas = canvasRef.current;
      const point = clientToCanvasPoint(event.clientX, event.clientY);
      if (canvas && point) {
        const { wx, wy } = screenToWorld(point.x, point.y, canvas);
        setMarkerInput({
          sx: event.clientX,
          sy: event.clientY,
          wx,
          wy,
        });
      }
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }

    const hit = pickNode(event.clientX, event.clientY);
    const moved = dragMoved.current;

    isDragging.current = false;
    dragMoved.current = false;
    dragStart.current = null;
    setIsDraggingVisual(false);
    suspendClusterEdgeRendering();
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!moved && hit) {
      const now = Date.now();
      const isDoubleClick = lastClickRef.current.nodeId === hit.node_id && (now - lastClickRef.current.time) < 300;
      lastClickRef.current = { time: now, nodeId: hit.node_id };

      if (isDoubleClick) {
        onNodeInspect?.(hit);
        return;
      }

      onSelectNode?.(hit);
    }
  }, [
    clientToCanvasPoint,
    onMultiSelect,
    onNodeInspect,
    onSelectNode,
    pickNode,
    projectNode,
    renderableNodes,
    screenToWorld,
    suspendClusterEdgeRendering,
    tool,
  ]);

  const handlePointerLeave = useCallback(() => {
    if (!isDragging.current && !isLassoDrawing.current) {
      setHoveredNode(null);
      onHoverNode?.(null);
    }
  }, [onHoverNode]);

  const handlePointerCancel = useCallback(() => {
    isDragging.current = false;
    dragMoved.current = false;
    dragStart.current = null;
    isLassoDrawing.current = false;
    lassoPointsRef.current = [];
    setLassoPoints([]);
    setIsDraggingVisual(false);
    suspendClusterEdgeRendering();
  }, [suspendClusterEdgeRendering]);

  const handleWheel = useCallback((event) => {
    event.preventDefault();

    const canvas = canvasRef.current;
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    if (!canvas || !point) {
      return;
    }

    const camera = cameraRef.current;
    const delta = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * canvas.height
        : event.deltaY;
    const zoomFactor = Math.exp(-delta * (event.ctrlKey ? 0.0022 : 0.0014));

    applyZoomAtPoint((camera.zoomScale ?? 1) * zoomFactor, point, canvas);
  }, [applyZoomAtPoint, clientToCanvasPoint]);

  const handleMinimapClick = useCallback((event) => {
    if (!worldBounds) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 6, 154);
    const y = clamp(event.clientY - rect.top, 6, 114);
    const wxMin = worldBounds.xMin - MAP_WORLD_PADDING;
    const wxMax = worldBounds.xMax + MAP_WORLD_PADDING;
    const wyMin = worldBounds.yMin - MAP_WORLD_PADDING;
    const wyMax = worldBounds.yMax + MAP_WORLD_PADDING;
    const wx = wxMin + (((x - 6) / 148) * (wxMax - wxMin));
    const wy = wyMin + (((y - 6) / 108) * (wyMax - wyMin));

    cameraRef.current = {
      ...cameraRef.current,
      x: -wx,
      y: -wy,
    };
    suspendClusterEdgeRendering();
  }, [suspendClusterEdgeRendering, worldBounds]);

  const handleZoomControl = useCallback((factor) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    applyZoomAtPoint(
      (cameraRef.current.zoomScale ?? 1) * factor,
      { x: canvas.width / 2, y: canvas.height / 2 },
      canvas,
    );
  }, [applyZoomAtPoint]);

  const handleZoomHome = useCallback(() => {
    fitToView(60);
  }, [fitToView]);

  const cursor = isDraggingVisual
    ? "grabbing"
    : tool === "lasso"
      ? "crosshair"
      : tool === "marker"
        ? "cell"
        : hoveredNode
          ? "pointer"
          : "default";

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={handleCanvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          cursor,
          touchAction: "none",
        }}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
      />

      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 18,
          pointerEvents: "none",
        }}
      >
        {categoryClusters.map((cluster) => {
          const clusterStyle = getCategoryClusterStyle(cluster.categoryKey);

          return (
            <div
              key={cluster.id}
              ref={(element) => registerClusterLabelRef(cluster.id, element)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: "translate(-9999px, -9999px)",
                transformOrigin: "center center",
                opacity: 0,
                transition: isDraggingVisual ? "none" : "opacity 120ms ease-out",
                willChange: "transform, opacity",
              }}
            >
              <div
                style={{
                  padding: 4,
                  borderRadius: 4,
                  background: clusterStyle.labelBg,
                }}
              >
                <span
                  style={{
                    color: clusterStyle.labelText,
                    fontFamily: "'Syne', sans-serif",
                    fontSize: 11,
                    fontWeight: 500,
                    lineHeight: 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {truncateText(cluster.label, 34)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "absolute",
          top: "50%",
          left: 14,
          transform: "translateY(-50%)",
          zIndex: 30,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "rgba(12,14,18,0.92)",
          border: "1px solid #1e2430",
          padding: "8px 6px",
          backdropFilter: "blur(8px)",
          borderRadius: 14,
        }}
      >
        {TOOLS.map((currentTool) => {
          const isActive = tool === currentTool.id;

          return (
            <button
              key={currentTool.id}
              type="button"
              title={currentTool.label}
              onClick={() => {
                setTool(currentTool.id);
              }}
              style={{
                width: 38,
                height: 38,
                background: "none",
                cursor: "pointer",
                border: `1px solid ${isActive ? "#00e5a0" : "#1e2430"}`,
                color: isActive ? "#00e5a0" : "#6b7590",
                fontSize: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
                borderRadius: 10,
              }}
            >
              {currentTool.icon}
            </button>
          );
        })}

        <div style={{ height: 1, background: "#1e2430", margin: "4px 0" }} />

        <button
          type="button"
          title="Clear"
          onClick={() => onMultiSelect?.([])}
          style={{
            width: 38,
            height: 38,
            background: "none",
            border: "1px solid #1e2430",
            color: "#3a4055",
            fontSize: 14,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
          }}
        >
          {"\u2715"}
        </button>
      </div>

      <canvas
        ref={minimapRef}
        width={160}
        height={120}
        onClick={handleMinimapClick}
        style={{
          position: "absolute",
          top: 14,
          right: 14,
          zIndex: 30,
          border: "1px solid #1e2430",
          background: "#080a0e",
          opacity: 0.85,
          cursor: "pointer",
          borderRadius: 12,
        }}
      />

      <div
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          zIndex: 30,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {[
          { label: "+", title: "Zoom In", onClick: () => handleZoomControl(1.2) },
          { label: "−", title: "Zoom Out", onClick: () => handleZoomControl(1 / 1.2) },
          { label: "⌂", title: "Fit View", onClick: handleZoomHome },
        ].map((control) => (
          <button
            key={control.title}
            type="button"
            title={control.title}
            onClick={control.onClick}
            style={{
              width: 28,
              height: 28,
              padding: 0,
              background: "#0c0e12",
              border: "1px solid #1e2430",
              color: "#00e5a0",
              borderRadius: 8,
              fontFamily: "'DM Mono', monospace",
              fontSize: 14,
              lineHeight: 1,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {control.label}
          </button>
        ))}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: 14,
          zIndex: 30,
          background: "rgba(12,14,18,0.92)",
          border: "1px solid #1e2430",
          fontFamily: "'DM Mono', monospace",
          minWidth: 210,
          backdropFilter: "blur(8px)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div
          onClick={() => setColoringOpen((current) => !current)}
          style={{
            padding: "8px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
            fontSize: 10,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "#6b7590",
          }}
        >
          Point Coloring
          <span style={{ color: "#3a4055" }}>{coloringOpen ? "\u2227" : "\u2228"}</span>
        </div>

        {coloringOpen && (
          <div style={{ padding: "8px 14px 12px", borderTop: "1px solid #1e2430" }}>
            {pointColoringItems.map(([color, label, count]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "3px 0",
                  fontSize: 11,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: color,
                    boxShadow: `0 0 4px ${color}`,
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: "#6b7590", flex: 1 }}>{label}</span>
                <span style={{ color: "#3a4055", fontSize: 10 }}>{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {markerInput && (
        <div
          style={{
            position: "fixed",
            left: markerInput.sx,
            top: markerInput.sy,
            zIndex: 200,
            background: "#0c0e12",
            border: "1px solid #00e5a0",
            padding: "8px",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <input
            autoFocus
            placeholder="Label..."
            style={{
              background: "transparent",
              border: "none",
              color: "#e8eaf0",
              fontFamily: "'DM Mono', monospace",
              fontSize: 12,
              outline: "none",
              width: 140,
            }}
            onBlur={() => setMarkerInput(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setMarkers((current) => [
                  ...current,
                  {
                    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    wx: markerInput.wx,
                    wy: markerInput.wy,
                    label: event.currentTarget.value.trim(),
                  },
                ]);
                setMarkerInput(null);
              }

              if (event.key === "Escape") {
                setMarkerInput(null);
              }
            }}
          />
        </div>
      )}

      {hoveredNode && (
        <div
          style={{
            position: "fixed",
            left: tooltipPos.x,
            top: tooltipPos.y,
            zIndex: 100,
            pointerEvents: "none",
            background: "rgba(12,14,18,0.97)",
            border: "1px solid #1e2430",
            padding: "12px 14px",
            maxWidth: 320,
            fontFamily: "'DM Mono', monospace",
            borderRadius: 12,
            boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: getSourceMeta(hoveredNode).color,
              marginBottom: 8,
            }}
          >
            {getSourceMeta(hoveredNode).label}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "#e8eaf0", marginBottom: 10 }}>
            {stripHtml(hoveredNode.claim_text).substring(0, 160)}
            {stripHtml(hoveredNode.claim_text).length > 160 ? "\u2026" : ""}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "#3a4055" }}>Friction</span>
            <div style={{ flex: 1, height: 2, background: "#1e2430" }}>
              <div
                style={{
                  height: "100%",
                  width: `${(hoveredNode.friction_score ?? 0) * 100}%`,
                  background: `rgb(${getNodeColor(hoveredNode).join(",")})`,
                }}
              />
            </div>
            <span style={{ fontSize: 11, color: "#e8eaf0" }}>
              {((hoveredNode.friction_score ?? 0) * 100).toFixed(0)}%
            </span>
          </div>
          {hoveredNode.contradicting_node_ids?.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10, color: "#ff3b5c" }}>
              CONTRADICTIONS: {hoveredNode.contradicting_node_ids.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default MapCanvas;
