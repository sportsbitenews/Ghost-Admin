import Service from '@ember/service';
import fetch from 'fetch';
import injectService from 'ember-service/inject';
import {isEmpty} from '@ember/utils';
import {or} from '@ember/object/computed';
import {reject, resolve} from 'rsvp';
import {task, taskGroup, timeout} from 'ember-concurrency';

const API_URL = 'https://api.unsplash.com';
const API_VERSION = 'v1';
const DEBOUNCE_MS = 600;

export default Service.extend({
    config: injectService(),
    settings: injectService(),

    columnCount: 3,
    columns: null,
    error: '',
    photos: null,
    searchTerm: '',

    _columnHeights: null,
    _pagination: null,

    applicationId: or('config.unsplashAPI.applicationId', 'settings.unsplash.applicationId'),
    isLoading: or('_search.isRunning', '_loadingTasks.isRunning'),

    init() {
        this._super(...arguments);
        this._reset();
    },

    loadNew() {
        this._reset();
        return this.get('_loadNew').perform();
    },

    loadNextPage() {
        // protect against scroll trigger firing when the photos are reset
        if (this.get('_search.isRunning')) {
            return;
        }

        if (isEmpty(this.get('photos'))) {
            return this.get('_loadNew').perform();
        }

        if (this._pagination.next) {
            return this.get('_loadNextPage').perform();
        }

        // TODO: return error?
        return reject();
    },

    changeColumnCount(newColumnCount) {
        if (newColumnCount !== this.get('columnCount')) {
            this.set('columnCount', newColumnCount);
            this._resetColumns();
        }
    },

    sendTestRequest(testApplicationId) {
        let url = `${API_URL}/photos/random`;
        let headers = {};

        headers.Authorization = `Client-ID ${testApplicationId}`;
        headers['Accept-Version'] = API_VERSION;

        return fetch(url, {headers})
            .then((response) => this._checkStatus(response));
    },

    actions: {
        updateSearch(term) {
            if (term === this.get('searchTerm')) {
                return;
            }

            this.set('searchTerm', term);
            this._reset();

            if (term) {
                return this.get('_search').perform(term);
            } else {
                return this.get('_loadNew').perform();
            }
        }
    },

    _loadingTasks: taskGroup().drop(),

    _loadNew: task(function* () {
        let url = `${API_URL}/photos?per_page=30`;
        yield this._makeRequest(url);
    }).group('_loadingTasks'),

    _loadNextPage: task(function* () {
        yield this._makeRequest(this._pagination.next);
    }).group('_loadingTasks'),

    _retryLastRequest: task(function* () {
        yield this._makeRequest(this._lastRequestUrl);
    }).group('_loadingTasks'),

    _search: task(function* (term) {
        yield timeout(DEBOUNCE_MS);

        let url = `${API_URL}/search/photos?query=${term}&per_page=30`;
        yield this._makeRequest(url);
    }).restartable(),

    _addPhotosFromResponse(response) {
        let photos = response.results || response;

        photos.forEach((photo) => this._addPhoto(photo));
    },

    _addPhoto(photo) {
        // pre-calculate ratio for later use
        photo.ratio = photo.height / photo.width;

        // add to general photo list
        this.get('photos').pushObject(photo);

        // add to least populated column
        this._addPhotoToColumns(photo);
    },

    _addPhotoToColumns(photo) {
        let min = Math.min(...this._columnHeights);
        let columnIndex = this._columnHeights.indexOf(min);

        // use a fixed width when calculating height to compensate for different
        // overall image sizes
        this._columnHeights[columnIndex] += 300 * photo.ratio;
        this.get('columns')[columnIndex].pushObject(photo);
    },

    _reset() {
        this.set('photos', []);
        this._pagination = {};
        this._resetColumns();
    },

    _resetColumns() {
        let columns = [];
        let columnHeights = [];

        // pre-fill column arrays based on columnCount
        for (let i = 0; i < this.get('columnCount'); i++) {
            columns[i] = [];
            columnHeights[i] = 0;
        }

        this.set('columns', columns);
        this._columnHeights = columnHeights;

        if (!isEmpty(this.get('photos'))) {
            this.get('photos').forEach((photo) => {
                this._addPhotoToColumns(photo);
            });
        }
    },

    _makeRequest(url) {
        let headers = {};

        // clear any previous error
        this.set('error', '');

        // store the url so it can be retried if needed
        this._lastRequestUrl = url;

        headers.Authorization = `Client-ID ${this.get('applicationId')}`;
        headers['Accept-Version'] = API_VERSION;

        return fetch(url, {headers})
            .then((response) => this._checkStatus(response))
            .then((response) => this._extractPagination(response))
            .then((response) => response.json())
            .then((response) => this._addPhotosFromResponse(response))
            .catch(() => {
                // if the error text isn't already set then we've get a connection error from `fetch`
                if (!this.get('error')) {
                    this.set('error', 'Uh-oh! Trouble reaching the Unsplash API, please check your connection');
                }
            });
    },

    _checkStatus(response) {
        // successful request
        if (response.status >= 200 && response.status < 300) {
            return resolve(response);
        }

        let errorText = '';
        let responseTextPromise = resolve();

        if (response.headers.map['content-type'] === 'application/json') {
            responseTextPromise = response.json().then((json) => {
                return json.errors[0];
            });
        } else if (response.headers.map['content-type'] === 'text/xml') {
            responseTextPromise = response.text();
        }

        return responseTextPromise.then((responseText) => {
            if (response.status === 403 && response.headers.map['x-ratelimit-remaining'] === '0') {
                // we've hit the ratelimit on the API
                errorText = 'Unsplash API rate limit reached, please try again later.';
            }

            errorText = errorText || responseText || `Error ${response.status}: Uh-oh! Trouble reaching the Unsplash API`;

            // set error text for display in UI
            this.set('error', errorText);

            // throw error to prevent further processing
            let error = new Error(errorText);
            error.response = response;
            throw error;
        });
    },

    _extractPagination(response) {
        let pagination = {};
        let linkRegex = new RegExp('<(.*)>; rel="(.*)"');
        let {link} = response.headers.map;

        if (link) {
            link.split(',').forEach((link) => {
                let [, url, rel] = linkRegex.exec(link);

                pagination[rel] = url;
            });
        }

        this._pagination = pagination;

        return response;
    }
});
