import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const TOOLS = [
  { id: "select", icon: "\u25B6", label: "Select" },
  { id: "lasso", icon: "\u2B21", label: "Lasso" },
  { id: "marker", icon: "\u25C8", label: "Marker" },
];

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

function getNodeColor(node) {
  const friction = node.friction_score ?? 0;
  let color = [0, 229, 160];

  if (friction >= 0.85) {
    color = [255, 48, 80];
  } else if (friction >= 0.6) {
    color = [255, 140, 0];
  } else if (friction >= 0.3) {
    color = [200, 220, 0];
  } else if (node.polarity === "inhibits") {
    color = [130, 80, 255];
  } else if (node.polarity === "promotes") {
    color = [0, 200, 255];
  }

  if (["pdf_document", "web_url", "youtube_video"].includes(node.source_type)) {
    return [
      clamp(Math.round((color[0] * 0.84) + 13), 0, 255),
      clamp(Math.round((color[1] * 0.9) + 11), 0, 255),
      clamp(Math.round((color[2] * 0.92) + 24), 0, 255),
    ];
  }

  return color;
}

function getBaseRadius(node, zoomLevel) {
  switch (zoomLevel) {
    case "galaxy":
      return 2;
    case "cluster":
      return node.source_type !== "public_abstract" ? 4 : 3;
    case "node":
      return node.source_type !== "public_abstract" ? 5.5 : 4.5;
    case "detail":
      return node.source_type !== "public_abstract" ? 7 : 6;
    default:
      return 3;
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

function computeClusterLabels(nodes) {
  const renderableNodes = nodes.filter(isRenderableNode);
  if (!renderableNodes.length) {
    return [];
  }

  const groups = {};
  const hasClusterIds = renderableNodes.some((node) => node.umap_cluster_id != null);

  if (hasClusterIds) {
    renderableNodes.forEach((node) => {
      const key = `cluster_${node.umap_cluster_id ?? "none"}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(node);
    });
  } else {
    const bounds = computeWorldBounds(renderableNodes);
    if (!bounds) {
      return [];
    }

    const cellCount = 10;
    renderableNodes.forEach((node) => {
      const col = clamp(
        Math.floor(((node.umap_x - bounds.xMin) / (bounds.spanX + 0.001)) * cellCount),
        0,
        cellCount - 1,
      );
      const row = clamp(
        Math.floor(((node.umap_y - bounds.yMin) / (bounds.spanY + 0.001)) * cellCount),
        0,
        cellCount - 1,
      );
      const key = `${row}_${col}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(node);
    });
  }

  let clusterIndex = 0;

  return Object.values(groups)
    .filter((group) => group.length >= 4)
    .map((group) => {
      const wx = group.reduce((sum, node) => sum + node.umap_x, 0) / group.length;
      const wy = group.reduce((sum, node) => sum + node.umap_y, 0) / group.length;
      const frequencies = {};
      let highestFrictionNode = group[0];

      group.forEach((node) => {
        const label = typeof node.subject_name === "string" ? node.subject_name.trim() : "";
        if (label && label.length <= 24) {
          frequencies[label] = (frequencies[label] ?? 0) + 1;
        }
        if ((node.friction_score ?? 0) > (highestFrictionNode?.friction_score ?? Number.NEGATIVE_INFINITY)) {
          highestFrictionNode = node;
        }
      });

      const dominantName = Object.entries(frequencies)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
      const fallbackName = typeof highestFrictionNode?.subject_name === "string"
        && highestFrictionNode.subject_name.trim()
        ? highestFrictionNode.subject_name.trim().slice(0, 24)
        : `Cluster ${clusterIndex + 1}`;

      clusterIndex += 1;

      return {
        wx,
        wy,
        text: dominantName ?? fallbackName,
        nodeCount: group.length,
        maxFriction: Math.max(...group.map((node) => node.friction_score ?? 0)),
      };
    });
}

function buildClusterMesh(nodes, clusterGroups) {
  const edges = [];

  Object.values(clusterGroups).forEach((group) => {
    if (group.length < 2) {
      return;
    }

    group.forEach((nodeA) => {
      const neighbors = group
        .filter((nodeB) => nodeB.node_id !== nodeA.node_id)
        .map((nodeB) => {
          const dx = nodeA.umap_x - nodeB.umap_x;
          const dy = nodeA.umap_y - nodeB.umap_y;
          return {
            node: nodeB,
            dist: Math.sqrt(dx * dx + dy * dy),
          };
        })
        .sort((left, right) => left.dist - right.dist)
        .slice(0, 3);

      neighbors.forEach(({ node: nodeB, dist }) => {
        if (dist > 8) {
          return;
        }

        const pairKey = [nodeA.node_id, nodeB.node_id].sort().join("::");
        edges.push({
          pairKey,
          ax: nodeA.umap_x,
          ay: nodeA.umap_y,
          bx: nodeB.umap_x,
          by: nodeB.umap_y,
          friction: Math.max(nodeA.friction_score ?? 0, nodeB.friction_score ?? 0),
        });
      });
    });
  });

  const seen = new Set();
  return edges.filter((edge) => {
    if (seen.has(edge.pairKey)) {
      return false;
    }
    seen.add(edge.pairKey);
    return true;
  });
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

function drawMesh(ctx, meshEdges, worldToScreen, canvas, zoom) {
  const zoomLevel = getZoomLevel(zoom);

  const width = canvas.width;
  const height = canvas.height;

  meshEdges.forEach((edge) => {
    const { sx: ax, sy: ay } = worldToScreen(edge.ax, edge.ay, canvas);
    const { sx: bx, sy: by } = worldToScreen(edge.bx, edge.by, canvas);

    if ((ax < -50 && bx < -50) || (ax > width + 50 && bx > width + 50) || (ay < -50 && by < -50) || (ay > height + 50 && by > height + 50)) {
      return;
    }

    const friction = edge.friction;
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
    } else if (friction >= 0.3) {
      red = 180;
      green = 210;
      blue = 40;
    }

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = `rgba(${red},${green},${blue},${zoomLevel === "cluster" ? 0.18 : 0.30})`;
    ctx.lineWidth = zoomLevel === "cluster" ? 0.5 : 0.8;
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

function drawClusterOutlines(ctx, clusterLabels, nodesByCluster, worldToScreen, canvas, zoom) {
  const zoomLevel = getZoomLevel(zoom);
  if (zoomLevel === "node" || zoomLevel === "detail") {
    return;
  }

  const hullAlpha = zoomLevel === "galaxy" ? 0.3 : 0.2;

  Object.values(nodesByCluster).forEach((group) => {
    if (group.length < 4) {
      return;
    }

    const screenPoints = group
      .filter((node) => node.umap_x != null && node.umap_y != null)
      .map((node) => {
        const { sx, sy } = worldToScreen(node.umap_x, node.umap_y, canvas);
        return { x: sx, y: sy };
      });

    if (screenPoints.length < 3) {
      return;
    }

    const centerX = screenPoints.reduce((sum, point) => sum + point.x, 0) / screenPoints.length;
    const centerY = screenPoints.reduce((sum, point) => sum + point.y, 0) / screenPoints.length;
    const hull = convexHull(screenPoints).map((point) => {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
      const padding = 16;
      return {
        x: point.x + ((dx / dist) * padding),
        y: point.y + ((dy / dist) * padding),
      };
    });

    if (hull.length < 3) {
      return;
    }

    const maxFriction = Math.max(...group.map((node) => node.friction_score ?? 0));
    let red = 0;
    let green = 229;
    let blue = 160;

    if (maxFriction >= 0.85) {
      red = 255;
      green = 48;
      blue = 80;
    } else if (maxFriction >= 0.6) {
      red = 255;
      green = 140;
      blue = 0;
    } else if (maxFriction >= 0.3) {
      red = 180;
      green = 210;
      blue = 40;
    }

    ctx.beginPath();
    ctx.moveTo(hull[0].x, hull[0].y);
    hull.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.fillStyle = `rgba(${red},${green},${blue},0.025)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${red},${green},${blue},${hullAlpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  void clusterLabels;
}

function drawNode(ctx, node, sx, sy, zoom, isSelected, isHovered, viewMode, isScoutFlagged, scoutHighlightColor) {
  const zoomLevel = getZoomLevel(zoom);
  const friction = node.friction_score ?? 0;
  const [red, green, blue] = getNodeColor(node);
  let drawX = sx;
  let drawY = sy;
  let scaleMult = 1;

  if (viewMode === "3D" && node.proj) {
    drawX = node.proj.sx;
    drawY = node.proj.sy;
    scaleMult = node.proj.scale;
  }

  const baseRadius = getBaseRadius(node, zoomLevel) * scaleMult;

  if (viewMode === "2.5D" && friction >= 0.6) {
    ctx.shadowColor = `rgba(${red}, ${green}, ${blue}, 0.6)`;
    ctx.shadowBlur = 15 + (friction * 4);
    ctx.shadowOffsetX = 6;
    ctx.shadowOffsetY = 8 + (friction * 4);
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  if (zoomLevel === "node" || zoomLevel === "detail") {
    const glowRadius = baseRadius * (friction >= 0.6 ? 4.5 : 3);
    const glowAlpha = friction >= 0.6 ? 0.18 : 0.08;
    const gradient = ctx.createRadialGradient(drawX, drawY, baseRadius * 0.5, drawX, drawY, glowRadius);
    gradient.addColorStop(0, `rgba(${red},${green},${blue},${glowAlpha})`);
    gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`);
    ctx.beginPath();
    ctx.arc(drawX, drawY, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(drawX, drawY, baseRadius, 0, Math.PI * 2);

  if (zoomLevel === "galaxy") {
    ctx.fillStyle = `rgb(${red},${green},${blue})`;
  } else {
    const coreGradient = ctx.createRadialGradient(drawX - (baseRadius * 0.3), drawY - (baseRadius * 0.3), 0, drawX, drawY, baseRadius);
    coreGradient.addColorStop(0, "rgba(255,255,255,0.95)");
    coreGradient.addColorStop(0.25, `rgba(${red},${green},${blue},1)`);
    coreGradient.addColorStop(1, `rgba(${Math.max(0, red - 40)},${Math.max(0, green - 40)},${Math.max(0, blue - 40)},0.9)`);
    ctx.fillStyle = coreGradient;
  }
  ctx.fill();

  if (zoomLevel !== "galaxy") {
    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.9)`;
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(drawX, drawY, baseRadius + 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.2)`;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  if (node.source_type !== "public_abstract" && zoomLevel !== "galaxy") {
    const size = baseRadius * 1.7;
    ctx.strokeStyle = `rgba(${red},${green},${blue},0.7)`;
    ctx.lineWidth = 0.8;
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
    ctx.arc(drawX, drawY, baseRadius + 8, 0, Math.PI * 2);
    ctx.strokeStyle = scoutHighlightColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = scoutHighlightColor;
    ctx.font = "7px 'DM Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("◈", drawX, drawY - baseRadius - 6);
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

export default function MapCanvas({
  nodes = [],
  allNodes = nodes,
  selectedIds = [],
  viewMode = "2D",
  scoutHighlightIds = [],
  scoutHighlightColor = "#ffb340",
  onSelectNode,
  onMultiSelect,
  onHoverNode,
  onNodeInspect,
}) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const minimapRef = useRef(null);
  const cameraRef = useRef({ x: 0, y: 0, zoom: 12, pitch: 0.8, yaw: 0.5 });
  const animationRef = useRef(null);
  const isDragging = useRef(false);
  const dragStart = useRef(null);
  const dragMoved = useRef(false);
  const lastClickRef = useRef({ time: 0, nodeId: null });
  const isLassoDrawing = useRef(false);
  const lassoPointsRef = useRef([]);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState("select");
  const [coloringOpen, setColoringOpen] = useState(true);
  const [markers, setMarkers] = useState([]);
  const [markerInput, setMarkerInput] = useState(null);
  const [lassoPoints, setLassoPoints] = useState([]);
  const [isDraggingVisual, setIsDraggingVisual] = useState(false);

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

  const clusterLabels = useMemo(
    () => computeClusterLabels(renderableNodes),
    [renderableNodes],
  );

  const nodesByCluster = useMemo(() => {
    const xs = renderableNodes.map((node) => node.umap_x).filter(Number.isFinite);
    const ys = renderableNodes.map((node) => node.umap_y).filter(Number.isFinite);
    if (!xs.length || !ys.length) {
      return {};
    }

    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const cells = 10;
    const groups = {};

    renderableNodes.forEach((node) => {
      const col = Math.min(
        Math.floor(((node.umap_x - xMin) / ((xMax - xMin) + 0.001)) * cells),
        cells - 1,
      );
      const row = Math.min(
        Math.floor(((node.umap_y - yMin) / ((yMax - yMin) + 0.001)) * cells),
        cells - 1,
      );
      const key = row * cells + col;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(node);
    });

    return groups;
  }, [renderableNodes]);

  const meshEdges = useMemo(
    () => buildClusterMesh(renderableNodes, nodesByCluster),
    [renderableNodes, nodesByCluster],
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

  const projectNode = useCallback((node, canvas) => {
    if (viewMode === "3D") {
      return project3D(node.umap_x, node.umap_y, (node.friction_score ?? 0) * 40, canvas);
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
    return {
      wx: ((sx - (canvas.width / 2)) / camera.zoom) - camera.x,
      wy: ((sy - (canvas.height / 2)) / camera.zoom) - camera.y,
    };
  }, []);

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

  useEffect(() => {
    if (!nodes.length) {
      return;
    }

    const xs = nodes.map((node) => node.umap_x).filter((value) => value != null);
    const ys = nodes.map((node) => node.umap_y).filter((value) => value != null);
    if (!xs.length) {
      return;
    }

    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const worldW = xMax - xMin + 4;
    const worldH = yMax - yMin + 4;

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const canvasW = canvas.offsetWidth || 800;
    const canvasH = canvas.offsetHeight || 600;
    const fitZoom = Math.min(canvasW / worldW, canvasH / worldH) * 0.82;
    const clampedZoom = Math.max(4, Math.min(fitZoom, 16));
    const centerX = (xMin + xMax) / 2;
    const centerY = (yMin + yMax) / 2;

    cameraRef.current = {
      x: -centerX,
      y: -centerY,
      zoom: clampedZoom,
      pitch: cameraRef.current.pitch ?? 0.8,
      yaw: cameraRef.current.yaw ?? 0.5,
    };
  }, [nodes]);

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
 
    const wxMin = worldBounds.xMin - 2;
    const wxMax = worldBounds.xMax + 2;
    const wyMin = worldBounds.yMin - 2;
    const wyMax = worldBounds.yMax + 2;
    const scaleX = 148 / Math.max(1, wxMax - wxMin);
    const scaleY = 108 / Math.max(1, wyMax - wyMin);

    renderableNodes.forEach((node) => {
      const mx = 6 + ((node.umap_x - wxMin) * scaleX);
      const my = 6 + ((node.umap_y - wyMin) * scaleY);
      const [red, green, blue] = (node.friction_score ?? 0) >= 0.6
        ? [255, 100, 50]
        : (node.friction_score ?? 0) >= 0.3
          ? [200, 220, 0]
          : node.polarity === "inhibits"
            ? [130, 80, 255]
            : [0, 180, 120];

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
    const zoomLevel = getZoomLevel(zoom);

    ctx.fillStyle = "#050608";
    ctx.fillRect(0, 0, width, height);

    if (zoomLevel !== "galaxy") {
      drawGrid(ctx, cameraRef.current, width, height);
    }

    if (viewMode !== "3D" && (zoomLevel === "galaxy" || zoomLevel === "cluster")) {
      drawClusterOutlines(ctx, clusterLabels, nodesByCluster, worldToScreen, canvas, zoom);
    }

    if (viewMode !== "3D" && (zoomLevel === "cluster" || zoomLevel === "node")) {
      drawMesh(ctx, meshEdges, worldToScreen, canvas, zoom);
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
    clusterLabels,
    drawMinimap,
    hoveredNode,
    lassoPoints,
    markers,
    meshEdges,
    nodeMap,
    nodesByCluster,
    project3D,
    projectNode,
    renderableNodes,
    scoutHighlightColor,
    scoutHighlightIdSet,
    selectedIdSet,
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
      dragStart.current = { x: event.clientX, y: event.clientY };
      return;
    }

    const hit = pickNode(event.clientX, event.clientY);
    setHoveredNode(hit);
    onHoverNode?.(hit);

    if (hit) {
      setTooltipPos({ x: event.clientX + 14, y: event.clientY - 10 });
    }
  }, [clientToCanvasPoint, onHoverNode, pickNode, tool, viewMode]);

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
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [clientToCanvasPoint, onHoverNode, tool]);

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
  }, []);

  const handleWheel = useCallback((event) => {
    event.preventDefault();

    const canvas = canvasRef.current;
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    if (!canvas || !point) {
      return;
    }

    const camera = cameraRef.current;
    const nextZoom = clamp(camera.zoom * (event.deltaY < 0 ? 1.12 : 0.9), 4, 110);

    if (viewMode === "3D") {
      camera.zoom = nextZoom;
      return;
    }

    const { wx, wy } = screenToWorld(point.x, point.y, canvas);
    camera.zoom = nextZoom;
    camera.x = ((point.x - (canvas.width / 2)) / nextZoom) - wx;
    camera.y = ((point.y - (canvas.height / 2)) / nextZoom) - wy;
  }, [clientToCanvasPoint, screenToWorld, viewMode]);

  const handleMinimapClick = useCallback((event) => {
    if (!worldBounds) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 6, 154);
    const y = clamp(event.clientY - rect.top, 6, 114);
    const wxMin = worldBounds.xMin - 2;
    const wxMax = worldBounds.xMax + 2;
    const wyMin = worldBounds.yMin - 2;
    const wyMax = worldBounds.yMax + 2;
    const wx = wxMin + (((x - 6) / 148) * (wxMax - wxMin));
    const wy = wyMin + (((y - 6) / 108) * (wyMax - wyMin));

    cameraRef.current = {
      ...cameraRef.current,
      x: -wx,
      y: -wy,
    };
  }, [worldBounds]);

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
        ref={canvasRef}
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
}
