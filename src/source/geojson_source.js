// @flow

import { Event, ErrorEvent, Evented } from '../util/evented';

import { extend } from '../util/util';
import EXTENT from '../data/extent';
import { ResourceType } from '../util/ajax';
import browser from '../util/browser';

import type {Source} from './source';
import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {PerformanceResourceTiming} from '../types/performance_resource_timing';

/**
 * 包含GeoJSON的数据源。
 * （具体选项设置请参考 [样式规范](https://www.mapbox.com/mapbox-gl-style-spec/#sources-geojson)。）
 *
 * @example
 * map.addSource('some id', {
 *     type: 'geojson',
 *     data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_ports.geojson'
 * });
 *
 * @example
 * map.addSource('some id', {
 *    type: 'geojson',
 *    data: {
 *        "type": "FeatureCollection",
 *        "features": [{
 *            "type": "Feature",
 *            "properties": {},
 *            "geometry": {
 *                "type": "Point",
 *                "coordinates": [
 *                    -76.53063297271729,
 *                    39.18174077994108
 *                ]
 *            }
 *        }]
 *    }
 * });
 *
 * @example
 * map.getSource('some id').setData({
 *   "type": "FeatureCollection",
 *   "features": [{
 *       "type": "Feature",
 *       "properties": { "name": "Null Island" },
 *       "geometry": {
 *           "type": "Point",
 *           "coordinates": [ 0, 0 ]
 *       }
 *   }]
 * });
 * @see [Draw GeoJSON points](https://www.mapbox.com/mapbox-gl-js/example/geojson-markers/)
 * @see [Add a GeoJSON line](https://www.mapbox.com/mapbox-gl-js/example/geojson-line/)
 * @see [Create a heatmap from points](https://www.mapbox.com/mapbox-gl-js/example/heatmap/)
 * @see [Create and style clusters](https://www.mapbox.com/mapbox-gl-js/example/cluster/)
 */
class GeoJSONSource extends Evented implements Source {
    type: 'geojson';
    id: string;
    minzoom: number;
    maxzoom: number;
    tileSize: number;
    attribution: string;

    isTileClipped: boolean;
    reparseOverscaled: boolean;
    _data: GeoJSON | string;
    _options: any;
    workerOptions: any;
    dispatcher: Dispatcher;
    map: Map;
    workerID: number;
    _loaded: boolean;
    _collectResourceTiming: boolean;
    _resourceTiming: Array<PerformanceResourceTiming>;
    _removed: boolean;

    /**
     * @private
     */
    constructor(id: string, options: GeojsonSourceSpecification & {workerOptions?: any, collectResourceTiming: boolean}, dispatcher: Dispatcher, eventedParent: Evented) {
        super();

        this.id = id;

        // `type` is a property rather than a constant to make it easy for 3rd
        // parties to use GeoJSONSource to build their own source types.
        this.type = 'geojson';

        this.minzoom = 0;
        this.maxzoom = 18;
        this.tileSize = 512;
        this.isTileClipped = true;
        this.reparseOverscaled = true;
        this._removed = false;

        this.dispatcher = dispatcher;
        this.setEventedParent(eventedParent);

        this._data = (options.data: any);
        this._options = extend({}, options);

        this._collectResourceTiming = options.collectResourceTiming;
        this._resourceTiming = [];

        if (options.maxzoom !== undefined) this.maxzoom = options.maxzoom;
        if (options.type) this.type = options.type;
        if (options.attribution) this.attribution = options.attribution;

        const scale = EXTENT / this.tileSize;

        // sent to the worker, along with `url: ...` or `data: literal geojson`,
        // so that it can load/parse/index the geojson data
        // extending with `options.workerOptions` helps to make it easy for
        // third-party sources to hack/reuse GeoJSONSource.
        this.workerOptions = extend({
            source: this.id,
            cluster: options.cluster || false,
            geojsonVtOptions: {
                buffer: (options.buffer !== undefined ? options.buffer : 128) * scale,
                tolerance: (options.tolerance !== undefined ? options.tolerance : 0.375) * scale,
                extent: EXTENT,
                maxZoom: this.maxzoom,
                lineMetrics: options.lineMetrics || false
            },
            superclusterOptions: {
                maxZoom: options.clusterMaxZoom !== undefined ?
                    Math.min(options.clusterMaxZoom, this.maxzoom - 1) :
                    (this.maxzoom - 1),
                extent: EXTENT,
                radius: (options.clusterRadius || 50) * scale,
                log: false
            }
        }, options.workerOptions);
    }

    load() {
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._updateWorkerData((err) => {
            if (err) {
                this.fire(new ErrorEvent(err));
                return;
            }

            const data: Object = { dataType: 'source', sourceDataType: 'metadata' };
            if (this._collectResourceTiming && this._resourceTiming && (this._resourceTiming.length > 0)) {
                data.resourceTiming = this._resourceTiming;
                this._resourceTiming = [];
            }

            // although GeoJSON sources contain no metadata, we fire this event to let the SourceCache
            // know its ok to start requesting tiles.
            this.fire(new Event('data', data));
        });
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    /**
     * 设置GeoJSON数据并重绘地图。
     *
     * @param {Object|string} data GeoJSON数据对象或者指向该对象的URL。对于较大的GeoJSON文件推荐使用URL的方式。
     * @returns {GeoJSONSource} this
     */
    setData(data: GeoJSON | string) {
        this._data = data;
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._updateWorkerData((err) => {
            if (err) {
                this.fire(new ErrorEvent(err));
                return;
            }

            const data: Object = { dataType: 'source', sourceDataType: 'content' };
            if (this._collectResourceTiming && this._resourceTiming && (this._resourceTiming.length > 0)) {
                data.resourceTiming = this._resourceTiming;
                this._resourceTiming = [];
            }
            this.fire(new Event('data', data));
        });

        return this;
    }

    /**
     * 对于可聚集的数据源，获取给定聚集簇的缩放层级。
     *
     * @param clusterId 给定聚集簇的 `cluster_id` 属性值。
     * @param callback 缩放层级值返回后将会执行的回调函数 (`(error, zoom) => { ... }`)。
     * @returns {GeoJSONSource} this
     */
    getClusterExpansionZoom(clusterId: number, callback: Callback<number>) {
        this.dispatcher.send('geojson.getClusterExpansionZoom', { clusterId, source: this.id }, callback, this.workerID);
        return this;
    }

    /**
     * 对于可聚集的数据源，获取给定聚集簇在下一层级的子聚集簇（以GeoJSON feature数组的形式）。
     *
     * @param clusterId 给定聚集簇的 `cluster_id` 属性值。
     * @param callback feature数组返回后将会执行的回调函数 (`(error, features) => { ... }`)。
     * @returns {GeoJSONSource} this
     */
    getClusterChildren(clusterId: number, callback: Callback<Array<GeoJSONFeature>>) {
        this.dispatcher.send('geojson.getClusterChildren', { clusterId, source: this.id }, callback, this.workerID);
        return this;
    }

    /**
     * 对于可聚集的数据源，获取给定聚集簇的所有原始点集合（以GeoJSON feature数组的形式）。
     *
     * @param clusterId 给定聚集簇的 `cluster_id` 属性值。
     * @param limit 返回集合中包含点的最大个数。
     * @param offset 返回集合将跳过的点的数量（例如可用于分页）。
     * @param callback feature数组返回后将会执行的回调函数 (`(error, features) => { ... }`)。
     * @returns {GeoJSONSource} this
     */
    getClusterLeaves(clusterId: number, limit: number, offset: number, callback: Callback<Array<GeoJSONFeature>>) {
        this.dispatcher.send('geojson.getClusterLeaves', {
            source: this.id,
            clusterId,
            limit,
            offset
        }, callback, this.workerID);
        return this;
    }

    /*
     * Responsible for invoking WorkerSource's geojson.loadData target, which
     * handles loading the geojson data and preparing to serve it up as tiles,
     * using geojson-vt or supercluster as appropriate.
     */
    _updateWorkerData(callback: Callback<void>) {
        const options = extend({}, this.workerOptions);
        const data = this._data;
        if (typeof data === 'string') {
            options.request = this.map._transformRequest(browser.resolveURL(data), ResourceType.Source);
            options.request.collectResourceTiming = this._collectResourceTiming;
        } else {
            options.data = JSON.stringify(data);
        }

        // target {this.type}.loadData rather than literally geojson.loadData,
        // so that other geojson-like source types can easily reuse this
        // implementation
        this.workerID = this.dispatcher.send(`${this.type}.loadData`, options, (err, result) => {
            if (this._removed || (result && result.abandoned)) {
                return;
            }

            this._loaded = true;

            if (result && result.resourceTiming && result.resourceTiming[this.id])
                this._resourceTiming = result.resourceTiming[this.id].slice(0);
            // Any `loadData` calls that piled up while we were processing
            // this one will get coalesced into a single call when this
            // 'coalesce' message is processed.
            // We would self-send from the worker if we had access to its
            // message queue. Waiting instead for the 'coalesce' to round-trip
            // through the foreground just means we're throttling the worker
            // to run at a little less than full-throttle.
            this.dispatcher.send(`${this.type}.coalesce`, { source: options.source }, null, this.workerID);
            callback(err);

        }, this.workerID);
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const message = tile.workerID === undefined ? 'loadTile' : 'reloadTile';
        const params = {
            type: this.type,
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            maxZoom: this.maxzoom,
            tileSize: this.tileSize,
            source: this.id,
            pixelRatio: browser.devicePixelRatio,
            showCollisionBoxes: this.map.showCollisionBoxes
        };

        tile.workerID = this.dispatcher.send(message, params, (err, data) => {
            tile.unloadVectorData();

            if (tile.aborted) {
                return callback(null);
            }

            if (err) {
                return callback(err);
            }

            tile.loadVectorData(data, this.map.painter, message === 'reloadTile');

            return callback(null);
        }, this.workerID);
    }

    abortTile(tile: Tile) {
        tile.aborted = true;
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }

    onRemove() {
        this._removed = true;
        this.dispatcher.send('removeSource', { type: this.type, source: this.id }, null, this.workerID);
    }

    serialize() {
        return extend({}, this._options, {
            type: this.type,
            data: this._data
        });
    }

    hasTransition() {
        return false;
    }
}

export default GeoJSONSource;
