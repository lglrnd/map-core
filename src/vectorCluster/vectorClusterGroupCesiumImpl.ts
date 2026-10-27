import type {
  Billboard,
  Entity,
  Label,
  PointPrimitive,
  VerticalOrigin,
} from '@vcmap-cesium/engine';
import {
  Cartographic,
  CustomDataSource,
  HeightReference,
  Math as CesiumMath,
} from '@vcmap-cesium/engine';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { getStylesArray } from '../util/featureconverter/convert.js';
import { getBillboardOptions } from '../util/featureconverter/pointToCesium.js';
import Projection from '../util/projection.js';
import type CesiumMap from '../map/cesiumMap.js';
import type { VectorClusterGroupImplementationOptions } from './vectorClusterGroup.js';
import VectorClusterCesiumContext from './vectorClusterCesiumContext.js';
import { getTerrainHeightSampler } from '../layer/cesium/terrainHeightSampler.js';
import type { SourceVectorContextSync } from '../layer/cesium/sourceVectorContextSync.js';
import { createSourceVectorContextSync } from '../layer/cesium/sourceVectorContextSync.js';
import VectorClusterGroupImpl from './vectorClusterGroupImpl.js';
import { vectorClusterGroupName } from './vectorClusterSymbols.js';
import type VectorLayer from '../layer/vectorLayer.js';
import { vcsLayerName } from '../layer/layerSymbols.js';
import { hidden } from '../layer/featureVisibility.js';

let scratchCartographic = new Cartographic();

/**
 * Clusters for vector layers containing point features only
 */
export default class VectorClusterGroupCesiumImpl extends VectorClusterGroupImpl<CesiumMap> {
  static get className(): string {
    return 'VectorClusterGroupCesiumImpl';
  }

  private _rootCollection: CustomDataSource;

  private _removeClusterEventListener: (() => void) | undefined;

  private _context: VectorClusterCesiumContext | undefined;

  private _sourceVectorContextSync: SourceVectorContextSync | undefined;

  private _getLayerByName: (name: string) => VectorLayer | undefined;

  constructor(
    map: CesiumMap,
    options: VectorClusterGroupImplementationOptions,
  ) {
    super(map, options);
    this._rootCollection = new CustomDataSource(this.name);
    this._rootCollection.clustering.clusterLabels = true;
    this._rootCollection.clustering.clusterPoints = false;
    this._rootCollection.clustering.enabled = true;
    this._rootCollection.clustering.minimumClusterSize = 2;
    this._rootCollection.clustering.pixelRange = options.clusterDistance;
    this._getLayerByName = options.getLayerByName;
  }

  private _onCluster(
    entities: Entity[],
    cluster: { billboard: Billboard; label: Label; point: PointPrimitive },
  ): void {
    const size = entities.length;
    if (size < 2) {
      return;
    }

    const features = entities.map((e) => e.olFeature);
    const feature = new Feature({ features });
    feature[vectorClusterGroupName] = this.name;
    const style = getStylesArray(this.style, feature, 0)[0];

    scratchCartographic = Cartographic.fromCartesian(
      cluster.billboard.position,
      undefined,
      scratchCartographic,
    );
    const position = Projection.wgs84ToMercator(
      [
        CesiumMath.toDegrees(scratchCartographic.longitude),
        CesiumMath.toDegrees(scratchCartographic.latitude),
        scratchCartographic.height,
      ],
      true,
    );
    feature.setGeometry(new Point(position));
    feature.on('change', () => {
      cluster.billboard.show = !feature[hidden];
    });

    const bbOptions = getBillboardOptions(
      feature,
      style,
      this.vectorProperties.getAltitudeMode(feature),
      this.vectorProperties,
    );

    if (bbOptions) {
      cluster.billboard.image = bbOptions.image as string;
      cluster.billboard.scale = bbOptions.scale as number;
      // Cesium positions a cluster billboard at the average of its members positions. Since those
      // already carry sampled terrain heights, the average is at a sensible height and must not be
      // clamped again - clamping would resolve against the rendered meshes and push the billboard
      // kilometers below the surface for everything outside the rendered tile set.
      cluster.billboard.heightReference = getTerrainHeightSampler(
        this.map.getScene()!,
      ).hasTerrain
        ? HeightReference.NONE
        : (bbOptions.heightReference as HeightReference);
      cluster.billboard.verticalOrigin =
        bbOptions.verticalOrigin as VerticalOrigin;
      if (bbOptions.eyeOffset) {
        cluster.billboard.eyeOffset = bbOptions.eyeOffset;
      }

      if (bbOptions.scaleByDistance) {
        cluster.billboard.scaleByDistance = bbOptions.scaleByDistance;
      }

      cluster.billboard.olFeature = feature;

      cluster.label.show = false;
      cluster.billboard.show = true;
    } else {
      cluster.label.show = false;
      cluster.billboard.show = false;
    }
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this._context = new VectorClusterCesiumContext(this._rootCollection);
      this._rootCollection[vectorClusterGroupName] = this.name;
      await this.map.addClusterDataSource(this._rootCollection);
      if (this.isDestroyed) {
        return;
      }
      this._sourceVectorContextSync = createSourceVectorContextSync(
        this._source,
        this._context,
        this.map.getScene()!,
        this.style,
        (f) =>
          this._getLayerByName(f[vcsLayerName]!)?.vectorProperties ??
          this.vectorProperties,
      );
      this._removeClusterEventListener =
        this._rootCollection.clustering.clusterEvent.addEventListener(
          (entities, cluster) => {
            this._onCluster(entities, cluster);
          },
        );
    }
    await super.initialize();
  }

  async activate(): Promise<void> {
    if (!this.active) {
      await super.activate();
      if (this.active) {
        this._sourceVectorContextSync?.activate();
        this._rootCollection.show = true;
      }
    }
  }

  deactivate(): void {
    this._rootCollection.show = false;
    this._sourceVectorContextSync?.deactivate();
    super.deactivate();
  }

  destroy(): void {
    if (this._removeClusterEventListener) {
      this._removeClusterEventListener();
    }
    if (this.initialized) {
      this._sourceVectorContextSync?.destroy();
      this._context?.destroy();
      this.map.removeClusterDataSource(this._rootCollection);
    }
    this._context = undefined;
    super.destroy();
  }
}
