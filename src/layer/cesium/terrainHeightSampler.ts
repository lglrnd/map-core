import {
  Cartographic,
  CesiumTerrainProvider,
  HeightReference,
  sampleTerrainMostDetailed,
} from '@vcmap-cesium/engine';
import type { Scene } from '@vcmap-cesium/engine';
import { getLogger } from '@vcsuite/logger';
import type { ConvertedItem } from '../../util/featureconverter/convert.js';
import {
  isRelativeHeightReference,
  isTerrainHeightReference,
} from '../../util/featureconverter/vectorHeightInfo.js';

/**
 * Maximum number of positions sampled in one call to the terrain provider. A batch is expanded into
 * one request per covered terrain tile, so this bounds how many requests are issued at once.
 */
const maxBatchSize = 250;

/**
 * How often a position whose height could not be determined is sampled again. `sampleTerrain` does
 * not reject when a tile request fails, it leaves the height undefined, so failed requests are
 * indistinguishable from missing coverage and have to be retried.
 */
const maxRetries = 2;

const retryDelay = 500;

type QueueEntry = {
  cartographic: Cartographic;
  resolve: (height: number | undefined) => void;
};

/**
 * Samples terrain heights from the scenes terrain provider.
 *
 * This is deliberately _not_ using `Scene.getHeight`. `Scene.getHeight` derives the height from the
 * globes currently rendered meshes. For positions outside the rendered tile set it falls back to the
 * deepest ancestor tile which has a mesh, which at low levels spans hundreds of kilometers. The
 * interpolated height of such a mesh is meaningless and can be several kilometers below the
 * ellipsoid. Billboards clamped against such a height end up far below the surface and no longer
 * track the terrain. The terrain provider on the other hand is view independent and authoritative.
 *
 * Requests are batched, since clustered layers typically add thousands of features at once.
 */
class TerrainHeightSampler {
  private _scene: Scene;

  private _queue: QueueEntry[] = [];

  private _flushHandle: ReturnType<typeof setTimeout> | undefined;

  private _destroyed = false;

  constructor(scene: Scene) {
    this._scene = scene;
  }

  /**
   * Whether the scene currently renders an actual terrain. Without one, heights are zero anyway
   * and clamping is a no-op, so sampling can be skipped entirely.
   */
  get hasTerrain(): boolean {
    return this._scene.terrainProvider instanceof CesiumTerrainProvider;
  }

  /**
   * Resolves the terrain height at the given position or undefined, if it could not be determined.
   * The passed cartographic is not modified.
   */
  sample(cartographic: Cartographic): Promise<number | undefined> {
    if (this._destroyed || !this.hasTerrain) {
      return Promise.resolve(undefined);
    }

    return new Promise<number | undefined>((resolve) => {
      this._queue.push({
        cartographic: Cartographic.clone(cartographic),
        resolve,
      });

      if (this._queue.length >= maxBatchSize) {
        this._flush();
      } else if (!this._flushHandle) {
        this._flushHandle = setTimeout(() => {
          this._flush();
        }, 0);
      }
    });
  }

  private _flush(): void {
    if (this._flushHandle) {
      clearTimeout(this._flushHandle);
      this._flushHandle = undefined;
    }

    const batch = this._queue.splice(0, maxBatchSize);
    if (batch.length === 0) {
      return;
    }
    if (this._queue.length > 0 && !this._flushHandle) {
      this._flushHandle = setTimeout(() => {
        this._flush();
      }, 0);
    }

    const { terrainProvider } = this._scene;
    if (!(terrainProvider instanceof CesiumTerrainProvider)) {
      batch.forEach(({ resolve }) => {
        resolve(undefined);
      });
      return;
    }

    this._sampleBatch(terrainProvider, batch).catch(() => {
      batch.forEach(({ resolve }) => {
        resolve(undefined);
      });
    });
  }

  /**
   * Samples a batch and retries every position which did not yield a height.
   *
   * `sampleTerrain` does not reject when a tile request fails, it leaves the corresponding height
   * undefined. A failed request is therefore indistinguishable from missing coverage, and under the
   * request load of a whole dataset a noticeable share of the tiles does fail. Without the retry,
   * those positions keep their ground relative height reference and are the ones which end up
   * floating.
   */
  private async _sampleBatch(
    terrainProvider: CesiumTerrainProvider,
    batch: QueueEntry[],
    attempt = 0,
  ): Promise<void> {
    let positions: Cartographic[];
    try {
      positions = await sampleTerrainMostDetailed(
        terrainProvider,
        // sampleTerrainMostDetailed writes the height into the passed cartographics
        batch.map(({ cartographic }) => Cartographic.clone(cartographic)),
      );
    } catch (e) {
      getLogger('TerrainHeightSampler').warning(
        `failed to sample terrain heights: ${String(e)}`,
      );
      batch.forEach(({ resolve }) => {
        resolve(undefined);
      });
      return;
    }

    const unresolved: QueueEntry[] = [];
    batch.forEach((entry, index) => {
      const height = positions[index]?.height;
      if (height == null) {
        unresolved.push(entry);
      } else {
        entry.resolve(height);
      }
    });

    if (unresolved.length === 0) {
      return;
    }

    if (attempt >= maxRetries || this._destroyed) {
      unresolved.forEach(({ resolve }) => {
        resolve(undefined);
      });
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, retryDelay * (attempt + 1));
    });
    if (this._destroyed) {
      unresolved.forEach(({ resolve }) => {
        resolve(undefined);
      });
      return;
    }

    // retry in smaller chunks, the failures are load related
    const chunkSize = Math.max(1, Math.ceil(maxBatchSize / 2 ** (attempt + 1)));
    const chunks: QueueEntry[][] = [];
    for (let i = 0; i < unresolved.length; i += chunkSize) {
      chunks.push(unresolved.slice(i, i + chunkSize));
    }
    for (const chunk of chunks) {
      // sequential on purpose, parallel retries would recreate the load which caused the failure
      // eslint-disable-next-line no-await-in-loop
      await this._sampleBatch(terrainProvider, chunk, attempt + 1);
    }
  }

  destroy(): void {
    this._destroyed = true;
    if (this._flushHandle) {
      clearTimeout(this._flushHandle);
      this._flushHandle = undefined;
    }
    this._queue.forEach(({ resolve }) => {
      resolve(undefined);
    });
    this._queue = [];
  }
}

/**
 * One sampler per scene, so requests of all vector contexts of a scene share the same batches.
 * Vector tile layers create a context per tile, sampling per context would defeat batching.
 */
const samplers = new WeakMap<Scene, TerrainHeightSampler>();

export function getTerrainHeightSampler(scene: Scene): TerrainHeightSampler {
  let sampler = samplers.get(scene);
  if (!sampler) {
    sampler = new TerrainHeightSampler(scene);
    samplers.set(scene, sampler);
  }
  return sampler;
}

export function destroyTerrainHeightSampler(scene: Scene): void {
  samplers.get(scene)?.destroy();
  samplers.delete(scene);
}

/**
 * Replaces ground relative height references of billboards and labels with absolute positions,
 * based on heights sampled from the scenes terrain provider.
 *
 * Cesium resolves ground relative height references against the globes currently rendered meshes.
 * For positions outside the rendered tile set that falls back to the deepest ancestor tile with a
 * mesh, whose triangles span hundreds of kilometers, so the resulting height is meaningless and
 * usually kilometers below the ellipsoid. The correction Cesium schedules for when the real tile
 * arrives does not reliably fire. Since clamped billboards are rendered with
 * `disableDepthTestDistance`, such billboards stay visible while floating through the scene instead
 * of being hidden by the terrain.
 */
export async function resolveTerrainHeights(
  scene: Scene,
  items: ConvertedItem[],
): Promise<void> {
  const sampler = getTerrainHeightSampler(scene);
  if (!sampler.hasTerrain) {
    return;
  }

  await Promise.all(
    items.map(async (item) => {
      if (item.type !== 'billboard' && item.type !== 'label') {
        return;
      }
      const options = item.item;
      const heightReference = options.heightReference ?? HeightReference.NONE;
      // 3D tile relative references cannot be resolved by sampling the terrain
      if (!options.position || !isTerrainHeightReference(heightReference)) {
        return;
      }

      // not using a scratch cartographic, since we await below
      const cartographic = Cartographic.fromCartesian(options.position);
      if (!cartographic) {
        return;
      }

      const terrainHeight = await sampler.sample(cartographic);
      if (terrainHeight == null) {
        return;
      }

      // for relative references the position height is the offset above ground
      const height = isRelativeHeightReference(heightReference)
        ? terrainHeight + cartographic.height
        : terrainHeight;

      options.position = Cartographic.toCartesian(
        Cartographic.fromRadians(
          cartographic.longitude,
          cartographic.latitude,
          height,
        ),
      );
      options.heightReference = HeightReference.NONE;
    }),
  );
}

export default TerrainHeightSampler;
