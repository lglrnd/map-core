import type {
  Billboard,
  HeightReference,
  Label,
  Scene,
} from '@vcmap-cesium/engine';
import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelStyle,
  VerticalOrigin,
} from '@vcmap-cesium/engine';
import { Icon, type Style } from 'ol/style.js';
import type { Coordinate } from 'ol/coordinate.js';
import ImageState from 'ol/ImageState.js';
import type { Feature } from 'ol/index.js';
import type { Point } from 'ol/geom.js';

import { parseNumber } from '@vcsuite/parsers';
import { getLogger } from '@vcsuite/logger';
import { createLineGeometries } from './lineStringToCesium.js';
import { getCesiumColor } from '../../style/styleHelpers.js';
import { getModelOrPointPrimitiveOptions } from './pointHelpers.js';
import type VectorProperties from '../../layer/vectorProperties.js';
import type { ColorType } from '../../style/vectorStyleItem.js';
import type { ConvertedItem } from './convert.js';
import type {
  RelativeHeightReference,
  VectorHeightInfo,
} from './vectorHeightInfo.js';
import {
  getWgs84CoordinatesForPoint,
  isClampedHeightReference,
} from './vectorHeightInfo.js';
import type { CesiumGeometryOption } from './vectorGeometryFactory.js';

export type BillboardOptions = Billboard.ConstructorOptions;

/**
 * Cesiums texture atlas identifies an image by its `src` (HTMLImageElement), falling back to its
 * `id` property and finally to a freshly created GUID. Openlayers only hands us an HTMLImageElement
 * for plain, already loaded icons - regular shapes (circles), colored icons and image bitmaps are
 * canvases without a `src` and still loading icons are passed on as a promise. Without an `id`,
 * cesium adds the very same image to the atlas once per billboard instead of once per image.
 * We therefore tag these images with a stable id.
 */
const billboardImageIds = new WeakMap<object, string>();
let billboardImageIdCount = 0;

function getBillboardImageId(image: object): string {
  let id = billboardImageIds.get(image);
  if (!id) {
    billboardImageIdCount += 1;
    id = `vcsBillboardImage${billboardImageIdCount}`;
    billboardImageIds.set(image, id);
  }
  return id;
}

const rasterizedBillboardImages = new WeakMap<
  HTMLImageElement,
  HTMLCanvasElement
>();

const maxRasterizeAttempts = 3;

/**
 * Rasterizes an image element into a canvas, caching the result on the image element.
 *
 * Chromium rasterizes SVG image elements lazily and its _WebGL_ upload path - unlike the 2D canvas
 * path - requires an already decoded bitmap. When it has none, `texSubImage2D` fails with
 * `INVALID_VALUE` instead of throwing. Cesium does not check `getError`, so the upload silently
 * writes nothing while the texture atlas still registers the image index and caches the resolved
 * promise in its id hash - the atlas region stays empty for good and every billboard using it
 * renders as a solid black rectangle. Since every vector tile creates its own BillboardCollection
 * and therefore its own atlas, a single such failure poisons that tile while its neighbours render
 * correctly. A canvas is backed by a real bitmap and uploads reliably.
 *
 * Returns undefined if the image cannot (yet) be rasterized, in which case nothing is cached so the
 * next attempt can succeed.
 */
function rasterizeBillboardImage(
  image: HTMLImageElement,
): HTMLCanvasElement | undefined {
  const cached = rasterizedBillboardImages.get(image);
  if (cached) {
    return cached;
  }

  const width = Math.ceil(image.naturalWidth || image.width);
  const height = Math.ceil(image.naturalHeight || image.height);
  if (!width || !height) {
    return undefined;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return undefined;
  }
  context.drawImage(image, 0, 0, width, height);

  try {
    const { data } = context.getImageData(0, 0, width, height);
    const hasContent = data.some(
      (value, index) => index % 4 === 3 && value > 0,
    );
    if (!hasContent) {
      // the browser has not rasterized the image yet. Do not cache the blank canvas,
      // otherwise every tile would reuse it for the lifetime of the image.
      return undefined;
    }
  } catch {
    // a tainted canvas cannot be inspected. Uploading it raises a SecurityError, which
    // is preferable to silently uploading the equally unusable image element.
  }

  rasterizedBillboardImages.set(image, canvas);
  return canvas;
}

/**
 * Prepares the image of an openlayers image style to be used as a cesium billboard image. Image
 * elements are rasterized into a canvas, since cesium cannot reliably upload them, and every image
 * cesium cannot identify by itself is tagged with a stable id, so the texture atlas adds it once
 * instead of once per billboard.
 * @param image the image returned by an openlayers image style
 * @param id an id to use, if the image is not identifiable by itself
 * @param attempt the number of rasterization attempts already made
 */
function prepareBillboardImage(
  image: object,
  id?: string,
  attempt = 0,
): object {
  if (image instanceof HTMLImageElement) {
    const rasterized = rasterizeBillboardImage(image);
    const imageId = id ?? image.src;
    if (!rasterized) {
      if (attempt >= maxRasterizeAttempts) {
        getLogger('pointToCesium').warning(
          `could not rasterize billboard image ${image.src}, the symbol may not render`,
        );
        return image; // cesium keys these by their src
      }
      // retry on the next frame rather than handing cesium an image element it cannot upload
      const promise = new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(prepareBillboardImage(image, imageId, attempt + 1));
        });
      });
      return Object.assign(promise, { id: imageId });
    }
    return prepareBillboardImage(rasterized, imageId);
  }

  const imageId = id ?? getBillboardImageId(image);
  billboardImageIds.set(image, imageId);
  (image as { id?: string }).id = imageId;
  return image;
}

export function getBillboardOptions(
  feature: Feature,
  style: Style,
  heightReference: HeightReference,
  vectorProperties: VectorProperties,
): Partial<BillboardOptions> | null {
  const imageStyle = style.getImage();
  if (imageStyle) {
    // ImageStyles should always have an opacity value between 0 and 1, default white Color
    const color = new Color(1.0, 1.0, 1.0, imageStyle.getOpacity());

    let image = null;
    if (imageStyle instanceof Icon) {
      imageStyle.load();
      if (imageStyle.getImageState() === ImageState.LOADING) {
        // the loading image already has its src set, so we can derive the atlas id up front and
        // use it for the image the promise eventually resolves to (which may be a canvas).
        const loadingImage = imageStyle.getImage(1) as HTMLImageElement;
        const imageId =
          loadingImage?.src || getBillboardImageId(loadingImage ?? imageStyle);
        const promise = new Promise((resolve, reject) => {
          const imageChangeListener = (): void => {
            if (
              imageStyle.getImageState() === ImageState.LOADED ||
              imageStyle.getImageState() === ImageState.EMPTY
            ) {
              resolve(prepareBillboardImage(imageStyle.getImage(1), imageId));
              imageStyle.unlistenImageChange(imageChangeListener);
            } else if (imageStyle.getImageState() === ImageState.ERROR) {
              reject(new Error('Image could not be loaded'));
              imageStyle.unlistenImageChange(imageChangeListener);
            }
          };
          imageStyle.listenImageChange(imageChangeListener);
        });
        image = Object.assign(promise, { id: imageId });
      }
    }
    if (!image) {
      image = prepareBillboardImage(imageStyle.getImage(1));
    }
    const options: Partial<BillboardOptions> = {
      color,
      scale: imageStyle.getScaleArray()[0],
      heightReference,
      verticalOrigin: VerticalOrigin.BOTTOM,
      id: feature.getId(),
    };

    // @ts-expect-error: cesium types are wrong here
    options.image = image;

    options.eyeOffset = vectorProperties.getEyeOffset(feature);
    options.scaleByDistance = vectorProperties.getScaleByDistance(feature);
    if (isClampedHeightReference(heightReference)) {
      options.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    }

    return options;
  }
  return null;
}

export type LabelOptions = Label.ConstructorOptions;
/**
 * extracts cesium label options from a feature and style
 * @param  feature
 * @param  style style.getText().getFill() is set by default to be #333,
 * if no fill is required set Fill empty by using style.getText().setFill()
 * @param  heightReference
 * @param  vectorProperties
 */
export function getLabelOptions(
  feature: Feature,
  style: Style,
  heightReference: HeightReference,
  vectorProperties: VectorProperties,
): Partial<LabelOptions> | null {
  const textStyle = style.getText();
  const text = textStyle ? textStyle.getText() : null;
  if (text && textStyle) {
    const options: Partial<LabelOptions> = {};

    options.text = text as string;

    options.heightReference = heightReference;

    const offsetX = textStyle.getOffsetX() ?? 0;
    const offsetY = textStyle.getOffsetY() ?? 0;
    options.pixelOffset = new Cartesian2(offsetX, offsetY);
    options.scale = textStyle.getScaleArray()[0];

    const font = textStyle.getFont();
    if (font) {
      options.font = font;
    }

    const fill = textStyle.getFill();
    const stroke = textStyle.getStroke();

    let labelStyle;
    if (fill) {
      options.fillColor = getCesiumColor(
        fill.getColor() as ColorType, // XXX PatternDescriptor
        [0, 0, 0, 1],
      );
      labelStyle = LabelStyle.FILL;
    }
    if (stroke) {
      options.outlineWidth = parseNumber(stroke.getWidth(), 1.0);
      options.outlineColor = getCesiumColor(stroke.getColor(), [0, 0, 0, 1]);
      labelStyle = LabelStyle.OUTLINE;
    }
    if (fill && stroke) {
      labelStyle = LabelStyle.FILL_AND_OUTLINE;
    }
    options.style = labelStyle;

    let horizontalOrigin;
    switch (textStyle.getTextAlign()) {
      case 'left':
        horizontalOrigin = HorizontalOrigin.LEFT;
        break;
      case 'right':
        horizontalOrigin = HorizontalOrigin.RIGHT;
        break;
      case 'center':
      default:
        horizontalOrigin = HorizontalOrigin.CENTER;
    }
    options.horizontalOrigin = horizontalOrigin;

    let verticalOrigin;
    switch (textStyle.getTextBaseline()) {
      case 'top':
        verticalOrigin = VerticalOrigin.TOP;
        break;
      case 'middle':
        verticalOrigin = VerticalOrigin.CENTER;
        break;
      case 'bottom':
        verticalOrigin = VerticalOrigin.BOTTOM;
        break;
      case 'alphabetic':
        verticalOrigin = VerticalOrigin.TOP;
        break;
      case 'hanging':
        verticalOrigin = VerticalOrigin.BOTTOM;
        break;
      default:
        verticalOrigin = VerticalOrigin.BASELINE;
    }
    options.verticalOrigin = verticalOrigin;
    options.eyeOffset = vectorProperties.getEyeOffset(feature);
    options.scaleByDistance = vectorProperties.getScaleByDistance(feature);

    if (isClampedHeightReference(heightReference)) {
      options.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    }
    return options;
  }
  return null;
}

/**
 * validates if a point is renderable
 */
export function validatePoint(point: Point): boolean {
  if (point.getType() !== 'Point') {
    return false;
  }
  const flatCoordinates = point.getFlatCoordinates();
  if (flatCoordinates && flatCoordinates.length >= 2) {
    return flatCoordinates.every((value) => Number.isFinite(value));
  }
  return false;
}

export function getLineGeometries(
  heightInfo: VectorHeightInfo<RelativeHeightReference | HeightReference.NONE>,
  position: Cartesian3,
  wgs84Coords: Coordinate,
  style: Style,
): CesiumGeometryOption<'line'>[] {
  const heightValueCorrection =
    heightInfo.skirt +
    heightInfo.storeyHeightsBelowGround.reduce(
      (sum, currentValue) => sum + currentValue,
      0,
    ) +
    heightInfo.storeyHeightsAboveGround.reduce(
      (sum, currentValue) => sum + currentValue,
      0,
    );

  const secondPoint = Cartesian3.fromDegrees(
    wgs84Coords[0],
    wgs84Coords[1],
    wgs84Coords[2] - heightValueCorrection,
  );
  const linePositions = [position, secondPoint];
  return createLineGeometries({ positions: linePositions }, heightInfo, style);
}

export async function getPointPrimitives(
  feature: Feature,
  geometry: Point,
  style: Style,
  vectorProperties: VectorProperties,
  scene: Scene,
  heightInfo: VectorHeightInfo,
): Promise<(CesiumGeometryOption | ConvertedItem)[]> {
  const wgs84Coords = getWgs84CoordinatesForPoint(geometry, heightInfo);
  const position = Cartesian3.fromDegrees(
    wgs84Coords[0],
    wgs84Coords[1],
    wgs84Coords[2],
  );
  const pointPrimitives: (CesiumGeometryOption | ConvertedItem)[] =
    await getModelOrPointPrimitiveOptions(
      feature,
      style,
      position,
      wgs84Coords,
      vectorProperties,
      heightInfo,
      scene,
    );

  if (pointPrimitives.length === 0) {
    const bbOptions = getBillboardOptions(
      feature,
      style,
      heightInfo.heightReference,
      vectorProperties,
    );
    if (bbOptions) {
      pointPrimitives.push({
        type: 'billboard',
        item: { ...bbOptions, position },
      });
    }

    const labelOptions = getLabelOptions(
      feature,
      style,
      heightInfo.heightReference,
      vectorProperties,
    );
    if (labelOptions) {
      pointPrimitives.push({
        type: 'label',
        item: { ...labelOptions, position },
      });
    }
  }

  if (
    !isClampedHeightReference(heightInfo.heightReference) &&
    (
      heightInfo as VectorHeightInfo<
        RelativeHeightReference | HeightReference.NONE
      >
    ).extruded &&
    style.getStroke()
  ) {
    pointPrimitives.push(
      ...getLineGeometries(
        heightInfo as VectorHeightInfo<
          RelativeHeightReference | HeightReference.NONE
        >,
        position,
        wgs84Coords,
        style,
      ),
    );
  }

  return pointPrimitives;
}
