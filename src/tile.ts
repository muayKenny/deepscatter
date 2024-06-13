import {
  Vector,
  tableFromIPC,
  RecordBatch,
  StructRowProxy,
  Schema,
  vectorFromArray,
} from 'apache-arrow';
import { add_or_delete_column } from './Deeptable';
import type { Deeptable } from './Deeptable';
type MinMax = [number, number];

export type Rectangle = {
  x: MinMax;
  y: MinMax;
};

// interface schema_entry {
//   name: string;
//   type: string;
//   extent: Array<any>;
//   keys?: Array<any>;
// }

import type { TileBufferManager } from './regl_rendering';
import type { ArrowBuildable, LazyTileManifest, TileManifest } from './shared';
import { isCompleteManifest } from './typing';

export type RecordBatchCache =
  | {
      batch: Promise<RecordBatch>;
      ready: false;
    }
  | {
      batch: Promise<RecordBatch>;
      schema: Schema;
      ready: true;
    };

// Keep a global index of tile numbers. These are used to identify points.
let tile_identifier = 0;

/**
 * A Tile is a collection of points in the deeptable that are grouped together:
 * it represents the basic unit of operation for most batched operations in
 * deepscatter including network packets, GPU calculations,
 * transformations on data, and render calls. It corresponds to a record batch
 * of data in the Arrow format, but a tile object can be instantiated without
 * having the record batch present, and includes instructions for building it.
 * The Tile object also holds its own place in a tree (usually, but not always,
 * a quadtree), and is responsible for certain information about all of its descendants
 * in the tree as well as itself.
 */
export class Tile {
  // public max_ix = -1;
  readonly key: string; // A unique identifier for this tile.
  protected _batch?: RecordBatch;
  parent: Tile | null;
  private _children: Array<Tile> = [];
  public _highest_known_ix?: number;
  public deeptable: Deeptable;
  public _transformations: Record<string, Promise<ArrowBuildable>> = {};
  public _deriveManifestFromTileMetadata?: Promise<LazyTileManifest>;
  //private _promiseOfChildren? = Promise<void>;
  private _partialManifest: Partial<TileManifest> | Partial<LazyTileManifest>;
  private _manifest?: TileManifest | LazyTileManifest;

  // A cache of fetchCalls for downloaded arrow tables, including any table schema metadata.
  // Tables may contain more than a single column, so this prevents multiple dispatch.
  //private _promiseOfChildren: Promise<Tile[]>;

  private arrowFetchCalls: Map<string | null, RecordBatchCache> = new Map();
  public numeric_id: number;
  // bindings to regl buffers holdings shadows of the RecordBatch.
  public _buffer_manager?: TileBufferManager;
  //public child_locations: string[] = [];

  /**
   *
   * @param key Either the string identifier of the tile,
   * OR a `TileManifest` object including an identifier.   *
   * @param parent The parent tile -- used to navigate through the tree.
   * @param deeptable The full atlas deeptable of which this tile is a part.
   */
  constructor(
    key:
      | string
      | (Partial<TileManifest> & { key: string })
      | Partial<LazyTileManifest & { key: string }>,
    parent: Tile | null,
    deeptable: Deeptable,
  ) {
    // If it's just initiated with a key, build that into a minimal manifest.
    let manifest:
      | (Partial<TileManifest> & { key: string })
      | Partial<LazyTileManifest & { key: string }>;
    if (typeof key === 'string') {
      manifest = { key };
    } else {
      manifest = key;
    }
    this.key = manifest.key;
    // if (manifest.min_ix === undefined) {
    //   manifest.min_ix = parent ? parent.max_ix + 1 : 0;
    // }
    // if (manifest.max_ix === undefined) {
    //   manifest.max_ix = manifest.min_ix + 1e5;
    // }
    this.parent = parent;
    this.deeptable = deeptable;

    if (deeptable === undefined) {
      throw new Error('No deeptable provided');
    }

    // Grab the next identifier off the queue. This should be async safe with the current setup, but
    // the logic might fall apart in truly parallel situations.
    this.numeric_id = tile_identifier++;

    if (isCompleteManifest(manifest)) this.manifest = manifest;
    this._partialManifest = manifest;
  }

  deleteColumn(colname: string) {
    if (this._batch) {
      this._buffer_manager?.release(colname);
      this._batch = add_or_delete_column(this.record_batch, colname, null);
    }
    // Ensure there is no cached version here.
    this.transformation_holder[colname] = undefined;
  }

  async get_column(colname: string): Promise<Vector> {
    const existing = this._batch?.getChild(colname);
    if (existing) {
      return existing;
    }
    if (this.deeptable.transformations[colname]) {
      await this.apply_transformation(colname);
      const vector = this.record_batch.getChild(colname);
      if (vector === null) {
        throw new Error(`Column ${colname} not found after transformation`);
      }
      return vector;
    }
    throw new Error(`Column ${colname} not found`);
  }

  /**
   *
   * @param fields A list of keys to be created if they don't exist.
   * Must have registered transformations.
   */
  async require_columns(fields: Iterable<string>): Promise<void> {
    await Promise.all([
      this.populateManifest(),
      ...[...fields].map((fieldname) =>
        this.get_column(fieldname).then(() => undefined),
      ),
    ]);
  }
  private transformation_holder: Record<string, Promise<void>> = {};

  async apply_transformation(name: string): Promise<void> {
    if (this.transformation_holder[name] !== undefined) {
      return this.transformation_holder[name];
    }
    const transform = this.deeptable.transformations[name];
    if (transform === undefined) {
      throw new Error(`Transformation ${name} is not defined`);
    }

    this.transformation_holder[name] = Promise.resolve(transform(this)).then(
      (transformed) => {
        if (transformed === undefined) {
          throw new Error(
            `Transformation ${name} failed by returning empty data. ` +
              `All transformation functions must return a typedArray or Arrow Vector.`,
          );
        }
        this._batch = add_or_delete_column(this._batch, name, transformed);
      },
    );
    return this.transformation_holder[name];
  }

  /**
   * Checks if the tile has
   *
   *
   * @param col The name of the field to check for.
   * @returns
   */
  hasLoadedColumn(col: string) {
    return !!this._batch && !!this._batch.getChild(col);
  }

  is_visible(max_ix: number, viewport_limits: Rectangle | undefined): boolean {
    // viewport_limits is in coordinate points.
    // Will typically be got by calling current_corners.

    // Top tile is always visible (even if offscreen).
    // if (!this.parent) {return true}
    if (this.min_ix === undefined) {
      return false;
    }

    if (this.min_ix > max_ix) {
      return false;
    }
    if (viewport_limits === undefined) {
      return true;
    }

    const c = this.extent;
    return !(
      c.x[0] > viewport_limits.x[1] ||
      c.x[1] < viewport_limits.x[0] ||
      c.y[0] > viewport_limits.y[1] ||
      c.y[1] < viewport_limits.y[0]
    );
  }

  *points(
    bounding: Rectangle | undefined,
    sorted = false,
  ): Iterable<StructRowProxy> {
    //if (!this.is_visible(1e100, bounding)) {
    //  return;
    //}
    for (const p of this) {
      if (p_in_rect([p.x as number, p.y as number], bounding)) {
        yield p;
      }
    }
    if (sorted === false) {
      for (const child of this.loadedChildren) {
        // TODO: fix
        if (!child.record_batch) {
          continue;
        }
        if (bounding && !child.is_visible(1e100, bounding)) {
          continue;
        }
        for (const p of child.points(bounding, sorted)) {
          if (p_in_rect([p.x as number, p.y as number], bounding)) {
            yield p;
          }
        }
      }
    } else {
      throw new Error('Sorted iteration not supported');
    }
  }

  forEach(callback: (p: StructRowProxy) => void) {
    for (const p of this.points(undefined, false)) {
      if (p === undefined) {
        continue;
      }
      callback(p);
    }
  }

  get manifest(): TileManifest | LazyTileManifest {
    if (!this._manifest)
      throw new Error('Attempted to access manifest on partially loaded tile.');

    return this._manifest;
  }

  set manifest(manifest: TileManifest | LazyTileManifest) {
    // Setting the manifest is the thing that spawns children.
    if (!manifest.children) {
      console.error({ manifest });
      throw new Error('Attempted to set an incomplete manifest.');
    }
    this._children = manifest.children.map((k: TileManifest | string) => {
      return new Tile(k, this, this.deeptable);
    });
    this.highest_known_ix = manifest.max_ix;
    this._manifest = manifest;
  }

  set highest_known_ix(val) {
    // Do nothing if it isn't actually higher.
    if (this._highest_known_ix == undefined || this._highest_known_ix < val) {
      this._highest_known_ix = val;
      if (this.parent) {
        // bubble value to parent, with same logic.
        this.parent.highest_known_ix = val;
      }
    }
  }

  // This number represent the highest-indexed point that has been loaded *on or below* this on
  // the quadtree. It can be useful for decisions about which portions of the quadtree to plumb,
  // and for decisions about rendering colors
  get highest_known_ix(): number {
    return this._highest_known_ix || -1;
  }

  get record_batch() {
    if (this._batch) {
      return this._batch;
    }

    if (this._manifest) {
      // This helps support legacy code that may fetch the record_batch
      // just for its number of rows.
      return new RecordBatch({
        // @ts-expect-error Arrow typing doesn't match this constructor.
        __null: vectorFromArray(Array(this.manifest.nPoints)),
      });
    }

    throw new Error(
      `Attempted to access table on tile ${this.key} without table buffer.`,
    );
  }

  get max_ix(): number {
    if (this.manifest?.max_ix !== undefined) {
      return this.manifest.max_ix;
    }
    if (this.parent) {
      return this.parent.max_ix + 1;
    }
    return -1;
  }

  get min_ix() {
    if (this._manifest && this.manifest?.min_ix !== undefined) {
      return this.manifest.min_ix;
    }
    if (this.parent) {
      return this.parent.max_ix + 1;
    }
    return -1;
  }

  *yielder() {
    for (const row of this.record_batch) {
      if (row) {
        yield row;
      }
    }
  }

  get extent(): Rectangle {
    if (this._manifest && this.manifest?.extent) {
      return this.manifest.extent;
    }
    return this.theoretical_extent;
  }

  [Symbol.iterator](): IterableIterator<StructRowProxy> {
    return this.yielder();
  }

  async download_to_depth(
    max_ix: number,
    suffix: string | null,
  ): Promise<void> {
    /**
     * Recursive fetch all tiles up to a certain depth.
     * Triggers many unnecessary calls: prefer
     * download instead if possible.
     */
    if (suffix === null) {
      await this.deriveManifestInfoFromTileMetadata();
    } else {
      await this.get_arrow(suffix);
    }
    if (this.max_ix < max_ix) {
      await Promise.all(
        this.loadedChildren.map(
          (child): Promise<void> => child.download_to_depth(max_ix, suffix),
        ),
      );
    }
  }

  // Retrieves an Arrow record batch from a remove location and attaches
  // all columns in it to the tile's record batch, creating the record batch
  // if it does not already exist.
  get_arrow(suffix: string | null): Promise<RecordBatch> {
    if (suffix === undefined) {
      throw new Error('EMPTY SUFFIX');
    }
    // By default fetches .../0/0/0.feather
    // But if you pass a suffix, gets
    // 0/0/0.suffix.feather

    // Use a cache to avoid dispatching multiple web requests.
    const existing = this.arrowFetchCalls.get(suffix);
    if (existing) {
      return existing.batch;
    }

    let url = `${this.deeptable.base_url}/${this.key}.feather`;
    if (suffix !== null) {
      // 3/4/3
      // suffix: 'text'
      // 3/4/3.text.feather
      url = url.replace(/.feather/, `.${suffix}.feather`);
    }

    let bufferPromise: Promise<ArrayBuffer>;

    if (this.deeptable.tileProxy !== undefined) {
      const endpoint = new URL(url).pathname;

      // This method apiCall is crafted to match the
      // ts-nomic package, but can accept other authentication.
      bufferPromise = this.deeptable.tileProxy
        .apiCall(endpoint, 'GET', null, null, { octetStreamAsUint8: true })
        .then((d) => d.buffer as ArrayBuffer);
    } else {
      const request: RequestInit = {
        method: 'GET',
      };
      bufferPromise = fetch(url, request).then((response) =>
        response.arrayBuffer(),
      );
    }
    const batch = bufferPromise.then((buffer) => {
      return tableFromIPC(buffer).batches[0];
    });

    this.arrowFetchCalls.set(suffix, {
      ready: false,
      batch,
    });

    void batch.then((b) => {
      this.arrowFetchCalls.set(suffix, {
        ready: true,
        batch,
        schema: b.schema,
      });
    });

    return batch;
  }

  /**
   * Guarantees that the basic elements of the tile manifest are populated,
   * such that we know where we are in the quadtree and can make decisions
   * about which columns to fetch, what the children are, what points are included
   * in this tile, etc.
   *
   * @returns void
   */
  async populateManifest(): Promise<void> {
    if (this._manifest) {
      return;
    } else if (this._partialManifest.children) {
      if (this._partialManifest.nPoints === undefined) {
        console.warn('Something is wrong here.');
      }
      this.manifest = {
        ...this._partialManifest,
        key: this.key,
        children: this._partialManifest.children as string[],
        min_ix: this.min_ix,
        max_ix: this.max_ix,
        extent: this.extent,
        nPoints: this._partialManifest.nPoints ?? -1,
      };
    } else {
      this.manifest = await this.deriveManifestInfoFromTileMetadata();
    }
  }

  preprocessRootTileInfo(): Promise<void> {
    return this.get_arrow(null).then((batch) => {
      if (!this._batch) {
        this._batch = batch;
      }
      // For every column in the root tile,
      // define a transformation for other children that says
      // 'load the main batch and pull out this column'.
      const { deeptable } = this;

      for (const field of batch.schema.fields) {
        if (!deeptable.transformations[field.name]) {
          deeptable.transformations[field.name] = async (tile: Tile) => {
            const batch = await tile.get_arrow(null);
            const vector = batch.getChild(field.name);
            if (vector === null) {
              throw new Error(`Column ${field.name} not found`);
            }
            return vector;
          };
        }
      }
    });
  }

  async deriveManifestInfoFromTileMetadata(): Promise<
    TileManifest | LazyTileManifest
  > {
    // This should only be called once per tile.
    if (this._deriveManifestFromTileMetadata !== undefined) {
      return this._deriveManifestFromTileMetadata;
    }

    const manifest: Partial<LazyTileManifest> = {};
    this._deriveManifestFromTileMetadata = this.get_arrow(null).then(
      async (batch) => {
        // For every column in the root tile,
        // define a transformation for other children that says
        // 'load the main batch and pull out this column'.
        const { deeptable } = this;
        // Ensure there are transformations for the columns in the root tile.
        for (const field of batch.schema.fields) {
          if (!deeptable.transformations[field.name]) {
            deeptable.transformations[field.name] = async (tile: Tile) => {
              const batch = await tile.get_arrow(null);
              const vector = batch.getChild(field.name);
              if (vector === null) {
                throw new Error(`Column ${field.name} not found`);
              }
              return vector;
            };
          }
        }

        // PARSE METADATA //
        const metadata = batch.schema.metadata;
        const extent = metadata.get('extent');
        if (extent) {
          manifest.extent = JSON.parse(extent) as Rectangle;
        } else {
          manifest.extent = this.theoretical_extent;
        }

        const children = metadata.get('children');

        if (children) {
          const stringChildren = JSON.parse(children) as string[];
          manifest.children = stringChildren;
        }

        // TODO: make ix optionally parsed from metadata, not column.
        const ixes = await this.get_column('ix');

        if (ixes === null) {
          throw 'No ix column in table';
        }
        manifest.min_ix = Number(ixes.get(0));
        manifest.max_ix = Number(ixes.get(ixes.length - 1));
        if (manifest.min_ix > manifest.max_ix) {
          console.error(
            'Corrupted metadata for tile: ',
            this.key,
            'attempting recovery',
          );
          manifest.max_ix = manifest.min_ix + 1e5;
          manifest.min_ix = 0;
        }
        const fullManifest = {
          key: this.key,
          children: manifest.children,
          min_ix: manifest.min_ix,
          max_ix: manifest.max_ix,
          extent: manifest.extent,
          nPoints: batch.numRows,
        } as const;
        return fullManifest;
      },
    );

    return this._deriveManifestFromTileMetadata;
  }

  /**
   * Sometimes it's useful to do operations on batches of tiles. This function
   * defines a grouping of tiles in the same general region to be operated on.
   * In general they will have about 80 elements (16 + 64), but the top level
   * has just 5. (4 + 1). Note a macro tile with the name [2/0/0] does not actually include
   * the tile [2/0/0] itself, but rather the tiles [4/0/0], [4/1/0], [4/0/1], [4/1/1], [5/0/0] etc.
   */

  get macrotile(): string {
    return macrotile(this.key);
  }

  get macro_siblings(): Array<string> {
    return macrotile_siblings(this.key);
  }

  // The children that have actually been created already.
  get loadedChildren(): Array<Tile> {
    // create or return children.

    // if (this._children === null) {
    //   throw new Error(
    //     'Attempted to access children on a tile before they were determined',
    //   );
    // }
    return this._children;
  }

  // Asynchronously forces generation of all child
  // tiles, and then returns them.
  async allChildren(): Promise<Array<Tile>> {
    if (this._children.length) {
      return this._children;
    }
    if (this._partialManifest?.children) {
      for (const child of this.manifest.children) {
        const childTile = new Tile(child, this, this.deeptable);
        this._children.push(childTile);
      }
      return this._children;
    }
    await this.populateManifest();
    return this._children;
  }

  // Quadtree tiles can have their limits calculated based on the structure.
  // There are cases where these may not be exact.
  get theoretical_extent(): Rectangle {
    if (this.deeptable.tileStucture === 'other') {
      // Only three-length-keys are treated as quadtrees.
      return this.deeptable.extent;
    }
    const base = this.deeptable.extent;
    const [z, x, y] = this.key.split('/').map((d) => parseInt(d));

    const x_step = base.x[1] - base.x[0];
    const each_x = x_step / 2 ** z;

    const y_step = base.y[1] - base.y[0];
    const each_y = y_step / 2 ** z;

    return {
      x: [base.x[0] + x * each_x, base.x[0] + (x + 1) * each_x],
      y: [base.y[0] + y * each_y, base.y[0] + (y + 1) * each_y],
    };
  }
}

type Point = [number, number];

// Is a point in a rectangle
export function p_in_rect(p: Point, rect: Rectangle | undefined) {
  if (rect === undefined) {
    return true;
  }
  return (
    p[0] < rect.x[1] && p[0] > rect.x[0] && p[1] < rect.y[1] && p[1] > rect.y[0]
  );
}

/**
 * Returns the coordinates of a 'macrotile' for any given tile.
 * This is an experimental feature that should not be relied on as
 * part of the public API.
 * @deprecated
 *
 * @param key The key to get the macrotile of
 * @param size The size of each macrotile, in z.
 * @param parents The implicit parents of each macrotile. (If 2, then the macrotile 0/0/0 would contain all tiles at depth 2 and 3)
 * @returns
 */
function macrotile(key: string, size = 2, parents = 2) {
  let [z, x, y] = key.split('/').map((d) => parseInt(d));
  let moves = 0;
  while (!(moves >= parents && z % size == 0)) {
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
    z = z - 1;
    moves++;
  }
  return `${z}/${x}/${y}`;
}

function macrotile_siblings(key: string, size = 2, parents = 2): Array<string> {
  return macrotile_descendants(macrotile(key, size, parents), size, parents);
}

const descendant_cache = new Map<string, string[]>();
function macrotile_descendants(
  macrokey: string,
  size = 2,
  parents = 2,
): Array<string> {
  const cached = descendant_cache.get(macrokey);
  if (cached) {
    return cached;
  }
  const parent_tiles = [[macrokey]];
  while (parent_tiles.length < parents) {
    parent_tiles.unshift(parent_tiles[0].map(quadtreeChildrenNames).flat());
  }
  const sibling_tiles = [parent_tiles[0].map(quadtreeChildrenNames).flat()];
  while (sibling_tiles.length < size) {
    sibling_tiles.unshift(sibling_tiles[0].map(quadtreeChildrenNames).flat());
  }
  sibling_tiles.reverse();
  const descendants = sibling_tiles.flat();
  descendant_cache.set(macrokey, descendants);
  return descendants;
}

function quadtreeChildrenNames(tile: string) {
  const [z, x, y] = tile.split('/').map((d) => parseInt(d)) as [
    number,
    number,
    number,
  ];
  const children = [] as string[];
  for (let i = 0; i < 4; i++) {
    children.push(`${z + 1}/${x * 2 + (i % 2)}/${y * 2 + Math.floor(i / 2)}`);
  }
  return children;
}

// Deprecated, for backwards compatibility.
export const QuadTile = Tile;
