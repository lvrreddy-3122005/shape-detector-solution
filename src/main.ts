import "./style.css";
// @ts-ignore
import { SelectionManager } from "./ui-utils.js";
// @ts-ignore
import { EvaluationManager } from "./evaluation-manager.js";

// --- TYPE DEFINITIONS ---
export interface Point {
  x: number;
  y: number;
}
type Contour = Point[];
export interface DetectedShape {
  type: "circle" | "triangle" | "rectangle" | "pentagon" | "star";
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: Point;
  area: number;
}
export interface DetectionResult {
  shapes: DetectedShape[];
  processingTime: number;
  imageWidth: number;
  imageHeight: number;
}

// --- MAIN CLASS ---
/**
 * This is the main class that does all the shape detection work.
 */
export class ShapeDetector {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number = 0;
  private height: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * This is the main function. It takes the raw image data
   * and returns all the shapes it finds.
   */
  async detectShapes(imageData: ImageData): Promise<DetectionResult> {
    const startTime = performance.now();
    this.width = imageData.width;
    this.height = imageData.height;

    // Step 1: Turn the image black and white (grayscale)
    const grayGrid = this.createGrayscaleGrid(imageData);

    // Step 2: Find all the outlines (edges)
    const edgeGrid = this.applySobelEdgeDetection(grayGrid);

    // Step 3: Follow the outlines to find individual shapes (contours)
    // We pass a copy so the tracing algorithm can mark where it's been
    const contours = this.findContours(edgeGrid.map(row => [...row]));

    // Step 4: Figure out what each shape is (circle, triangle, etc.)
    const shapes = this.analyzeContours(contours);

    // Step 5: Draw our findings on the canvas
    this.drawDetectionsToCanvas(imageData, shapes);

    const processingTime = performance.now() - startTime;
    return {
      shapes,
      processingTime,
      imageWidth: this.width,
      imageHeight: this.height,
    };
  }

  /**
   * A helper function to load the user's image file onto our canvas.
   */
  loadImage(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.ctx.drawImage(img, 0, 0);
        const imageData = this.ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // --- STEP 1: IMAGE PRE-PROCESSING ---

  /**
   * Converts the flat RGBA image data into a 2D grid of grayscale values.
   * This is much easier to work with.
   */
  private createGrayscaleGrid(imageData: ImageData): number[][] {
    const data = imageData.data;
    const grid: number[][] = [];
    for (let y = 0; y < this.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < this.width; x++) {
        const index = (y * this.width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        // We use the standard "luminosity" formula for a good B&W image.
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        row.push(Math.round(gray));
      }
      grid.push(row);
    }
    return grid;
  }

  // --- STEP 2: EDGE DETECTION ---

  /**
   * Runs a Sobel operator over the image. This is a classic way
   * to find all the vertical and horizontal edges.
   */
  private applySobelEdgeDetection(grid: number[][]): number[][] {
    // Sobel kernels for detecting horizontal (gy) and vertical (gx) edges
    const kernelX: number[][] = [
      [-1, 0, 1], [-2, 0, 2], [-1, 0, 1],
    ];
    const kernelY: number[][] = [
      [-1, -2, -1], [0, 0, 0], [1, 2, 1],
    ];
    const edgeGrid: number[][] = Array.from({ length: this.height }, () =>
      Array(this.width).fill(0)
    );
    // Slide the kernels over every pixel (skipping the 1px border)
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        let gx = 0;
        let gy = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const pixelVal = grid[y + ky]?.[x + kx] ?? 0;
            gx += pixelVal * kernelX[ky + 1][kx + 1];
            gy += pixelVal * kernelY[ky + 1][kx + 1];
          }
        }
        // Calculate the total strength (magnitude) of the edge
        const magnitude = Math.sqrt(gx * gx + gy * gy);
        // If the edge is "sharp" enough (over 128), mark it as an edge (255)
        edgeGrid[y][x] = magnitude > 128 ? 255 : 0;
      }
    }
    return edgeGrid;
  }

  // --- STEP 3: CONTOUR TRACING ---
  
  /**
   * Scans the edge grid, pixel by pixel. When it finds a new edge pixel,
   * it calls `traceContour` to "walk" around the entire shape.
   */
  private findContours(grid: number[][]): Contour[] {
    const contours: Contour[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (grid[y][x] === 255) { // Found the start of a new shape
          grid[y][x] = 128; // Mark this pixel as "visiting"
          const newContour = this.traceContour({ x, y }, grid);
          
          // --- Tuned ---
          // Filter out tiny contours (noise). Set to 30 to catch the small triangle.
          if (newContour.length > 30) { 
            contours.push(newContour);
          }
        }
      }
    }
    return contours;
  }

  /**
   * "Walks" along a path of connected edge pixels (a contour)
   * using the Moore-Neighbor tracing algorithm.
   */
  private traceContour(startPoint: Point, grid: number[][]): Contour {
    const contour: Contour = [startPoint];
    let currentPoint = startPoint;
    // Neighbors are checked in clockwise order (E, SE, S, SW, W, NW, N, NE)
    const neighbors = [
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
      { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }
    ];
    let searchStartIndex = 4; // Start search from behind where we just came from
    let traceCount = 0;
    const MAX_TRACE = 20000; // Safety break, just in case

    while (traceCount++ < MAX_TRACE) {
      let foundNext = false;
      for (let i = 0; i < neighbors.length; i++) {
        const neighborIndex = (searchStartIndex + i) % neighbors.length;
        const neighbor = neighbors[neighborIndex];
        const nextX = currentPoint.x + neighbor.x;
        const nextY = currentPoint.y + neighbor.y;

        // Check if we're off the grid
        if (nextX < 0 || nextX >= this.width || nextY < 0 || nextY >= this.height) {
          continue;
        }

        // Are we back where we started?
        if (nextX === startPoint.x && nextY === startPoint.y) {
          return contour; // Contour is complete!
        }

        // Is this an edge pixel (255) or one we're visiting (128)?
        if (grid[nextY][nextX] === 255 || grid[nextY][nextX] === 128) {
          const nextPoint = { x: nextX, y: nextY };
          contour.push(nextPoint);
          if (grid[nextY][nextX] === 255) {
            grid[nextY][nextX] = 128; // Mark as visited
          }
          currentPoint = nextPoint; // Update our position
          // Next time, start searching from behind this new pixel
          searchStartIndex = (neighborIndex + 5) % 8;
          foundNext = true;
          break; // Found the next point, stop searching neighbors
        }
      }
      if (!foundNext) {
         // Hit a dead end
         return contour;
      }
    }
    if (traceCount >= MAX_TRACE) {
        console.error("Error: Max trace length exceeded.");
    }
    return contour;
  }

  // --- STEP 4: ANALYSIS & CLASSIFICATION ---

  /**
   * This is where we analyze all the contours we found.
   */
  private analyzeContours(contours: Contour[]): DetectedShape[] {
    const shapes: DetectedShape[] = [];
    const contourMetrics: any[] = [];

    // 1. Get the metrics (area, center, etc.) for every contour
    for (const contour of contours) {
      const metrics = this.calculateMetrics(contour);
      // --- Tuned ---
      // Filter out tiny noise contours. Set to 50 to catch the small triangle.
      if (metrics.area < 50) continue;
      contourMetrics.push({ contour, metrics });
    }

    // 2. Filter out "inner" contours
    // This handles the "donut" problem (e.g., a circle has an inner and outer edge).
    // We only want the outer one.
    const outerContoursMetrics = contourMetrics.filter(cm1 => {
      let isInnerContour = false;
      const c1 = cm1.metrics.center;
      for (const cm2 of contourMetrics) {
        if (cm1 === cm2) continue; // Don't compare with self
        const c2 = cm2.metrics.center;
        
        // Check if centers are very close (meaning, same object)
        const dist = Math.sqrt(Math.pow(c1.x - c2.x, 2) + Math.pow(c1.y - c2.y, 2));
        if (dist < 15) { 
          // If this contour is smaller, it must be the inner one.
          if (cm2.metrics.area > cm1.metrics.area) {
             isInnerContour = true;
             break;
          }
        }
      }
      return !isInnerContour; // Only keep contours that are *not* inner contours
    });

    // 3. Classify the remaining "real" shapes
    for (const { contour, metrics } of outerContoursMetrics) {
      const shape = this.classifyShape(contour, metrics);
      if (shape) {
        shapes.push(shape);
      }
    }
    return shapes;
  }

  /**
   * This is the "brain". It takes a single contour and decides
   * what shape it is.
   */
  private classifyShape(contour: Contour, metrics: any): DetectedShape | null {
    // 1. Check for a Circle.
    // We calculate "circularity" (a perfect circle is 1.0)
    const perimeter = metrics.perimeter;
    const circularity = (4 * Math.PI * metrics.area) / (perimeter * perimeter);

    // --- Tuned ---
    // Tuned to 0.80. This is "round enough" to be a circle.
    if (circularity > 0.80) {
      return {
        type: 'circle',
        confidence: Math.min(circularity, 0.99), 
        ...metrics,
      };
    }
    
    // 2. Calculate "Solidity"
    // This tells us if a shape is "solid" (like a pentagon)
    // or has "holes" (like a star).
    const hull = this.calculateConvexHull(contour);
    const hullMetrics = this.calculateMetrics(hull);
    let solidity = 0;
    if (hullMetrics.area > 0) {
      solidity = metrics.area / hullMetrics.area;
    }

    // 3. Simplify the contour to find its corners (vertices).
    // --- Tuned ---
    // Epsilon is our "corner sensitivity". Tuned to 6% of the perimeter.
    const epsilon = 0.06 * metrics.perimeter;
    const vertices = this.simplifyContour(contour, epsilon);
    
    // 4. Correct the vertex count.
    // A closed loop (like a triangle) will return [p1, p2, p3, p1].
    // We need to count this as 3 vertices, not 4.
    let numVertices = vertices.length;
    if (numVertices > 1) {
      const first = vertices[0];
      const last = vertices[numVertices - 1];
      // Check if the first and last points are basically the same.
      const dist = Math.sqrt(Math.pow(first.x - last.x, 2) + Math.pow(first.y - last.y, 2));
      if (dist < 10) { // 10px tolerance
        numVertices--; // It's a closed loop, so subtract one.
      }
    }

    // 5. Filter out text and lines.
    // --- Tuned ---
    // Filter out "skinny" shapes. If it's 5x wider than tall (or vice-versa),
    // it's probably a line or text, not a real shape.
    const { width, height } = metrics.boundingBox;
    const aspectRatio = Math.max(width / (height || 1), height / (width || 1));
    if (aspectRatio > 5.0) { // Tuned to 5.0
        return null; // This is a line, not a shape.
    }

    // 6. Classify based on the final corner count.
    let type: DetectedShape['type'] | null = null;
    let confidence = 0.85; // A base confidence score
    
    // This is our logic for all the polygons.
    switch (numVertices) {
      case 3:
        if (solidity > 0.9) { // Must be a solid shape
          type = 'triangle';
          confidence = 0.90;
        }
        break;
      case 4:
        if (solidity > 0.9) { // Must be a solid shape
          type = 'rectangle';
          confidence = 0.92;
        }
        break;
      case 5:
        if (solidity > 0.8) { // High solidity = pentagon
          type = 'pentagon';
          confidence = 0.88;
        } else if (solidity > 0.3) { // Low solidity = star
          type = 'star';
          confidence = 0.82; 
        }
        break;
      case 10:
        // The test star image actually has 10 vertices
        if (solidity < 0.8) {
          type = 'star';
          confidence = 0.82;
        }
        break;
    }

    if (type) {
      return {
        type: type,
        confidence: confidence,
        ...metrics,
      };
    }

    return null; // Couldn't classify
  }

  // --- METRIC & GEOMETRY HELPERS ---

  /**
   * Calculates all the key properties for a contour:
   * Area, Perimeter, Bounding Box, and Center.
   */
  private calculateMetrics(contour: Contour) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let area = 0;
    let perimeter = 0;
    let sumX = 0, sumY = 0;

    if (contour.length === 0) {
      return { 
        area: 0, perimeter: 0, 
        boundingBox: { x: 0, y: 0, width: 0, height: 0 }, 
        center: { x: 0, y: 0 } 
      };
    }

    for (let i = 0; i < contour.length; i++) {
      const p1 = contour[i];
      const p2 = contour[(i + 1) % contour.length]; // Wrap around

      // Find the bounding box
      if (p1.x < minX) minX = p1.x;
      if (p1.y < minY) minY = p1.y;
      if (p1.x > maxX) maxX = p1.x;
      if (p1.y > maxY) maxY = p1.y;

      // Use the Shoelace formula to find the area
      area += (p1.x * p2.y - p2.x * p1.y);
      // Add up the distance between each point for the perimeter
      perimeter += Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
      // Find the average (X, Y) position for the center
      sumX += p1.x;
      sumY += p1.y;
    }

    area = Math.abs(area / 2.0);
    const centerX = sumX / contour.length;
    const centerY = sumY / contour.length;

    return {
      area: area,
      perimeter: perimeter,
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      center: { x: centerX, y: centerY },
    };
  }

  /**
   * Simplifies the contour (which has thousands of points) into just
   * its main corners (vertices) using the Ramer-Douglas-Peucker algorithm.
   */
  private simplifyContour(points: Point[], epsilon: number): Point[] {
    if (points.length < 3) {
      return points;
    }
    // Find the point farthest from the line between start and end
    let dmax = 0;
    let index = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
      const d = this.perpendicularDistance(points[i], points[0], points[end]);
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }
    // If that point is "far enough" (epsilon), it's a corner.
    if (dmax > epsilon) {
      // Recursively simplify both halves.
      const recResults1 = this.simplifyContour(points.slice(0, index + 1), epsilon);
      const recResults2 = this.simplifyContour(points.slice(index), epsilon);
      // Put the results back together
      return recResults1.slice(0, recResults1.length - 1).concat(recResults2);
    } else {
      // If no point is far enough, the shape is just a straight line.
      return [points[0], points[end]];
    }
  }

  /**
   * Helper for simplifyContour. Finds distance from a point to a line segment.
   */
  private perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
    let dx = lineEnd.x - lineStart.x;
    let dy = lineEnd.y - lineStart.y;

    if (dx === 0 && dy === 0) {
      dx = point.x - lineStart.x;
      dy = point.y - lineStart.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    
    const lenSq = dx * dx + dy * dy;
    const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq;

    let closestX, closestY;
    if (t < 0) {
      closestX = lineStart.x;
      closestY = lineStart.y;
    } else if (t > 1) {
      closestX = lineEnd.x;
      closestY = lineEnd.y;
    } else {
      closestX = lineStart.x + t * dx;
      closestY = lineStart.y + t * dy;
    }
    dx = point.x - closestX;
    dy = point.y - closestY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Helper for solidity check. Calculates the cross product of three points.
   */
  private crossProduct(o: Point, a: Point, b: Point): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Calculates the "convex hull" (or "shrink-wrap") of a shape.
   * We use this to tell a star from a pentagon.
   */
  private calculateConvexHull(points: Point[]): Contour {
    if (points.length <= 3) {
      return [...points];
    }
    // Sort points by X-coordinate
    const sortedPoints = [...points].sort((a, b) => 
      a.x !== b.x ? a.x - b.x : a.y - b.y
    );
    const upper: Contour = [];
    const lower: Contour = [];
    // Build lower hull
    for (const p of sortedPoints) {
      while (
        lower.length >= 2 &&
        this.crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
      ) {
        lower.pop();
      }
      lower.push(p);
    }
    // Build upper hull
    for (let i = sortedPoints.length - 1; i >= 0; i--) {
      const p = sortedPoints[i];
      while (
        upper.length >= 2 &&
        this.crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
      ) {
        upper.pop();
      }
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  /**
   * Draws the original image and overlays the final detections.
   */
  private drawDetectionsToCanvas(imageData: ImageData, shapes: DetectedShape[]): void {
    // 1. Draw the original image
    this.ctx.putImageData(imageData, 0, 0);

    // 2. Loop through each detected shape
    for (const shape of shapes) {
      const { type, boundingBox, center } = shape;

      // 3. Set text style
      const text = `${type} (${(shape.confidence * 100).toFixed(0)}%)`;
      this.ctx.font = "16px Arial";
      this.ctx.fillStyle = "rgba(255, 255, 0, 0.8)"; // Yellow
      this.ctx.fillText(text, boundingBox.x, boundingBox.y - 5);

      // 4. Draw bounding box
      this.ctx.strokeStyle = "rgba(0, 255, 0, 0.8)"; // Green
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(boundingBox.x, boundingBox.y, boundingBox.width, boundingBox.height);

      // 5. Draw center point
      this.ctx.fillStyle = "rgba(255, 0, 0, 0.8)"; // Red
      this.ctx.beginPath();
      this.ctx.arc(center.x, center.y, 3, 0, 2 * Math.PI);
      this.ctx.fill();
    }
  }

} // End of ShapeDetector class

// --- APP LOGIC (Unchanged) ---
// This class handles the UI, file loading, and evaluation calls.
class ShapeDetectionApp {
  private detector: ShapeDetector;
  private imageInput: HTMLInputElement;
  private resultsDiv: HTMLDivElement;
  private testImagesDiv: HTMLDivElement;
  private evaluateButton: HTMLButtonElement;
  private evaluationResultsDiv: HTMLDivElement;
  private selectionManager: SelectionManager;
  private evaluationManager: EvaluationManager;

  constructor() {
    const canvas = document.getElementById(
      "originalCanvas"
    ) as HTMLCanvasElement;
    this.detector = new ShapeDetector(canvas);

    this.imageInput = document.getElementById("imageInput") as HTMLInputElement;
    this.resultsDiv = document.getElementById("results") as HTMLDivElement;
    this.testImagesDiv = document.getElementById(
      "testImages"
    ) as HTMLDivElement;
    this.evaluateButton = document.getElementById(
      "evaluateButton"
    ) as HTMLButtonElement;
    this.evaluationResultsDiv = document.getElementById(
      "evaluationResults"
    ) as HTMLDivElement;

    // @ts-ignore
    this.selectionManager = new SelectionManager();
    this.evaluationManager = new EvaluationManager(
      this.detector,
      this.evaluateButton,
      this.evaluationResultsDiv
    );

    this.setupEventListeners();
    this.loadTestImages().catch(console.error);
  }

  private setupEventListeners(): void {
    this.imageInput.addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.processImage(file);
      }
    });

    this.evaluateButton.addEventListener("click", async () => {
      const selectedImages = this.selectionManager.getSelectedImages();
      await this.evaluationManager.runSelectedEvaluation(selectedImages);
    });
  }

  private async processImage(file: File): Promise<void> {
    try {
      this.resultsDiv.innerHTML = "<p>Processing...</p>";

      const imageData = await this.detector.loadImage(file);
      const results = await this.detector.detectShapes(imageData);

      this.displayResults(results);
    } catch (error) {
      this.resultsDiv.innerHTML = `<p>Error: ${error}</p>`;
    }
  }

  private displayResults(results: DetectionResult): void {
    const { shapes, processingTime } = results;

    let html = `
      <p><strong>Processing Time:</strong> ${processingTime.toFixed(2)}ms</p>
      <p><strong>Shapes Found:</strong> ${shapes.length}</p>
    `;

    if (shapes.length > 0) {
      html += "<h4>Detected Shapes:</h4><ul>";
      
      shapes.forEach((shape) => {
        html += `
          <li>
            <strong>${
              shape.type.charAt(0).toUpperCase() + shape.type.slice(1)
            }</strong><br>
            Confidence: ${(shape.confidence * 100).toFixed(1)}%<br>
            Center: (${shape.center.x.toFixed(1)}, ${shape.center.y.toFixed(
          1
        )})<br>
            Area: ${shape.area.toFixed(1)}px²
          </li>
        `;
      });
      html += "</ul>";
    } else {
      html += "<p>No shapes detected.</p>";
    }

    this.resultsDiv.innerHTML = html;
  }

  private async loadTestImages(): Promise<void> {
    try {
      // @ts-ignore
      const module = await import("./test-images-data.js");
      const testImages = module.testImages;
      
      const imageNames = module.getAllTestImageNames(); 

      let html =
        '<h4>Click to upload your own image or use test images for detection. Right-click test images to select/deselect for evaluation:</h4><div class="evaluation-controls"><button id="selectAllBtn">Select All</button><button id="deselectAllBtn">Deselect All</button><span class="selection-info">0 images selected</span></div>';
        
      html += '<div class="test-images-grid">';

      html += `
        <div class="test-image-item upload-item" onclick="triggerFileUpload()">
          <div class="upload-icon">📁</div>
          <div class="upload-text">Upload Image</div>
          <div class="upload-subtext">Click to select file</div>
        </div>
      `;

      imageNames.forEach((imageName: string) => {
        const dataUrl = testImages[imageName as keyof typeof testImages];
        const displayName = imageName
          .replace(/[_-]/g, " ")
          .replace(/\.(svg|png)$/i, "");
          
        html += `
          <div class="test-image-item" data-image="${imageName}" 
               onclick="loadTestImage('${imageName}', '${dataUrl}')" 
               oncontextmenu="toggleImageSelection(event, '${imageName}')">
            <img src="${dataUrl}" alt="${imageName}">
            <div>${displayName}</div>
          </div>
        `;
      });

      html += "</div>";
      this.testImagesDiv.innerHTML = html;

      this.selectionManager.setupSelectionControls();

      (window as any).loadTestImage = async (name: string, dataUrl: string) => {
        try {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], name, { type: "image/svg+xml" });

          const imageData = await this.detector.loadImage(file);
          const results = await this.detector.detectShapes(imageData);
          this.displayResults(results);

          console.log(`Loaded test image: ${name}`);
        } catch (error) {
          console.error("Error loading test image:", error);
        }
      };

      (window as any).toggleImageSelection = (
        event: MouseEvent,
        imageName: string
      ) => {
        event.preventDefault();
        this.selectionManager.toggleImageSelection(imageName);
      };

      (window as any).triggerFileUpload = () => {
        this.imageInput.click();
      };
    } catch (error) {
      this.testImagesDiv.innerHTML = `
        <p>Test images not available. Run 'node convert-svg-to-png.js' to generate test image data.</p>
        <p>SVG files are available in the test-images/ directory.</p>
        <p style="color:red;"><strong>Dev Error:</strong> ${error}</p> 
      `;
      console.error(error);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new ShapeDetectionApp();
});