// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

// [START app]

const async = require('async');
const bodyParser = require('body-parser');
const config = require('./config.js');
const express = require('express');
const expressWinston = require('express-winston');
const http = require('http');
const persist = require('node-persist');
const request = require('request-promise');
const session = require('express-session');
const sessionFileStore = require('session-file-store');
const uuid = require('uuid');
const winston = require('winston');

const app = express();
const fileStore = sessionFileStore(session);
const server = http.Server(app);

// Use the EJS template engine
app.set('view engine', 'ejs');


// Set up a cache for media items that expires after 55 minutes.
// This caches the baseUrls for media items that have been selected
// by the user for the photo frame. They are used to display photos in
// thumbnails and in the frame. The baseUrls are send to the frontend and
// displayed from there. The baseUrls are cached temporarily to ensure that the
// app is responsive and quick. Note that this data should only be stored for a
// short amount of time and that access to the URLs expires after 60 minutes.
// See the 'best practices' and 'acceptable use policy' in the developer
// documentation.
const mediaItemCache = persist.create({
  dir: 'persist-mediaitemcache/',
  ttl: 3300000,  // 55 minutes
});
mediaItemCache.init();

// Temporarily cache a list of the albums owned by the user. This caches
// the name and base Url of the cover image. This ensures that the app
// is responsive when the user picks an album.
// Loading a full list of the albums owned by the user may take multiple
// requests. Caching this temporarily allows the user to go back to the
// album selection screen without having to wait for the requests to
// complete every time.
// Note that this data is only cached temporarily as per the 'best practices' in
// the developer documentation. Here it expires after 10 minutes.
const albumCache = persist.create({
  dir: 'persist-albumcache/',
  ttl: 600000,  // 10 minutes
});
albumCache.init();

// For each user, the app stores the last search parameters or album
// they loaded into the photo frame. The next time they log in
// (or when the cached data expires), this search is resubmitted.
// This keeps the data fresh. Instead of storing the search parameters,
// we could also store a list of the media item ids and refresh them,
// but resubmitting the search query ensures that the photo frame displays
// any new images that match the search criteria (or that have been added
// to an album).
const storage = persist.create({dir: 'persist-storage/'});
storage.init();

// Set up OAuth 2.0 authentication through the passport.js library.
const passport = require('passport');
const auth = require('./auth');
auth(passport);

// Set up a session middleware to handle user sessions.
// NOTE: A secret is used to sign the cookie. This is just used for this sample
// app and should be changed.
const sessionMiddleware = session({
  resave: true,
  saveUninitialized: true,
  store: new fileStore({}),
  secret: 'photo frame sample',
});

// Console transport for winton.
const consoleTransport = new winston.transports.Console();

// Set up winston logging.
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    consoleTransport
  ]
});

// Enable extensive logging if the DEBUG environment variable is set.
if (process.env.DEBUG) {
  // Print all winston log levels.
  logger.level = 'silly';

  // Enable express.js debugging. This logs all received requests.
  app.use(expressWinston.logger({
    transports: [
          consoleTransport
        ],
        winstonInstance: logger
  }));
  // Enable request debugging.
  require('request-promise').debug = true;
} else {
  // By default, only print all 'verbose' log level messages or below.
  logger.level = 'verbose';
}


// Set up static routes for hosted libraries.
app.use(express.static('static'));
app.use('/js', express.static(__dirname + '/node_modules/jquery/dist/'));
app.use(
    '/fancybox',
    express.static(__dirname + '/node_modules/@fancyapps/fancybox/dist/'));
app.use(
    '/mdlite',
    express.static(__dirname + '/node_modules/material-design-lite/dist/'));


// Parse application/json request data.
app.use(bodyParser.json());

// Parse application/xwww-form-urlencoded request data.
app.use(bodyParser.urlencoded({extended: true}));

// Enable user session handling.
app.use(sessionMiddleware);

// Set up passport and session handling.
app.use(passport.initialize());
app.use(passport.session());

// Middleware that adds the user of this session as a local variable,
// so it can be displayed on all pages when logged in.
app.use((req, res, next) => {
  res.locals.name = '-';
  if (req.user && req.user.profile && req.user.profile.name) {
    res.locals.name =
        req.user.profile.name.givenName || req.user.profile.displayName;
  }

  res.locals.avatarUrl = '';
  if (req.user && req.user.profile && req.user.profile.photos) {
    res.locals.avatarUrl = req.user.profile.photos[0].value;
  }
  next();
});


// GET request to the root.
// Display the login screen if the user is not logged in yet, otherwise the
// photo frame.
app.get('/', (req, res) => {
  if (!req.user || !req.isAuthenticated()) {
    // Not logged in yet.
    res.render('pages/login');
  } else {
    res.render('pages/frame');
  }
});

// GET request to log out the user.
// Destroy the current session and redirect back to the log in screen.
app.get('/logout', (req, res) => {
  req.logout();
  req.session.destroy();
  res.redirect('/');
});

// Star the OAuth login process for Google.
app.get('/auth/google', passport.authenticate('google', {
  scope: config.scopes,
  failureFlash: true,  // Display errors to the user.
  session: true,
}));

// Callback receiver for the OAuth process after log in.
app.get(
    '/auth/google/callback',
    passport.authenticate(
        'google', {failureRedirect: '/', failureFlash: true, session: true}),
    (req, res) => {
      // User has logged in.
      logger.info('User has logged in.');
      res.redirect('/');
    });

// Loads the search page if the user is authenticated.
// This page includes the search form.
app.get('/search', (req, res) => {
  renderIfAuthenticated(req, res, 'pages/search');
});

// Loads the album page if the user is authenticated.
// This page displays a list of albums owned by the user.
app.get('/album', (req, res) => {
  renderIfAuthenticated(req, res, 'pages/album');
});


// Handles form submissions from the search page.
// The user has made a selection and wants to load photos into the photo frame
// from a search query.
// Construct a filter and submit it to the Library API in
// libraryApiSearch(authToken, parameters).
// Returns a list of media items if the search was successful, or an error
// otherwise.
app.post('/loadFromSearch', async (req, res) => {
  const authToken = req.user.token;

  logger.info('Loading images from search.');
  logger.silly('Received form data: ', req.body);

  // Construct a filter for photos.
  // Other parameters are added below based on the form submission.
  const filters = {contentFilter: {}, mediaTypeFilter: {mediaTypes: ['PHOTO']}};

  if (req.body.includedCategories) {
    // Included categories are set in the form. Add them to the filter.
    filters.contentFilter.includedContentCategories =
        [req.body.includedCategories];
  }

  if (req.body.excludedCategories) {
    // Excluded categories are set in the form. Add them to the filter.
    filters.contentFilter.excludedContentCategories =
        [req.body.excludedCategories];
  }

  // Add a date filter if set, either as exact or as range.
  if (req.body.dateFilter == 'exact') {
    filters.dateFilter = {
      dates: constructDate(
          req.body.exactYear, req.body.exactMonth, req.body.exactDay),
    }
  } else if (req.body.dateFilter == 'range') {
    filters.dateFilter = {
      ranges: [{
        startDate: constructDate(
            req.body.startYear, req.body.startMonth, req.body.startDay),
        endDate:
            constructDate(req.body.endYear, req.body.endMonth, req.body.endDay),
      }]
    }
  }

  // Create the parameters that will be submitted to the Library API.
  const parameters = {filters};

  // Submit the search request to the API and wait for the result.
  const data = await libraryApiSearch(authToken, parameters);

  // Return and cache the result and parameters.
  const userId = req.user.profile.id;
  returnPhotos(res, userId, data, parameters);
});

// Handles selections from the album page where an album ID is submitted.
// The user has selected an album and wants to load photos from an album
// into the photo frame.
// Submits a search for all media items in an album to the Library API.
// Returns a list of photos if this was successful, or an error otherwise.
app.post('/loadFromAlbum', async (req, res) => {
  const albumId = req.body.albumId;
  const userId = req.user.profile.id;
  const authToken = req.user.token;

  logger.info(`Importing album: ${albumId}`);

  // To list all media in an album, construct a search request
  // where the only parameter is the album ID.
  // Note that no other filters can be set, so this search will
  // also return videos that are otherwise filtered out in libraryApiSearch(..).
  const parameters = {albumId};

  // Submit the search request to the API and wait for the result.
  const data = await libraryApiSearch(authToken, parameters);

  returnPhotos(res, userId, data, parameters)
});

// Returns all albums owned by the user.
app.get('/getAlbums', async (req, res) => {
  logger.info('Loading albums');
  const userId = req.user.profile.id;

  // Attempt to load the albums from cache if available.
  // Temporarily caching the albums makes the app more responsive.
  const cachedAlbums = await albumCache.getItem(userId);
  if (cachedAlbums) {
    logger.verbose('Loaded albums from cache.');
    res.status(200).send(cachedAlbums);
  } else {
    logger.verbose('Loading albums from API.');
    // Albums not in cache, retrieve the albums from the Library API
    // and return them
    const data = await libraryApiGetAlbums(req.user.token);
    if (data.error) {
      // Error occured during the request. Albums could not be loaded.
      returnError(res, data);
      // Clear the cached albums.
      albumCache.removeItem(userId);
    } else {
      // Albums were successfully loaded from the API. Cache them
      // temporarily to speed up the next request and return them.
      // The cache implementation automatically clears the data when the TTL is
      // reached.
      res.status(200).send(data);
      albumCache.setItemSync(userId, data);
    }
  }
});


// Returns a list of the media items that the user has selected to
// be shown on the photo frame.
// If the media items are still in the temporary cache, they are directly
// returned, otherwise the search parameters that were used to load the photos
// are resubmitted to the API and the result returned.
app.get('/getQueue', async (req, res) => {
  const userId = req.user.profile.id;
  const authToken = req.user.token;

  logger.info('Loading queue.');

  // Attempt to load the queue from cache first. This contains full mediaItems
  // that include URLs. Note that these expire after 1 hour. The TTL on this
  // cache has been set to this limit and it is cleared automatically when this
  // time limit is reached. Caching this data makes the app more responsive,
  // as it can be returned directly from memory whenever the user navigates
  // back to the photo frame.
  const cachedPhotos = await mediaItemCache.getItem(userId);
  const stored = await storage.getItem(userId);

  if (cachedPhotos) {
    // Items are still cached. Return them.
    logger.verbose('Returning cached photos.');
    res.status(200).send({photos: cachedPhotos, parameters: stored.parameters});
  } else if (stored && stored.parameters) {
    // Items are no longer cached. Resubmit the stored search query and return
    // the result.
    logger.verbose(
        `Resubmitting filter search ${JSON.stringify(stored.parameters)}`);
    const data = await libraryApiSearch(authToken, stored.parameters);
    returnPhotos(res, userId, data, stored.parameters);
  } else {
    // No data is stored yet for the user. Return an empty response.
    // The user is likely new.
    logger.verbose('No cached data.')
    res.status(200).send({});
  }
});



// Start the server
server.listen(config.port, () => {
  console.log(`App listening on port ${config.port}`);
  console.log('Press Ctrl+C to quit.');
});

// Renders the given page if the user is authenticated.
// Otherwise, redirects to "/".
function renderIfAuthenticated(req, res, page) {
  if (!req.user || !req.isAuthenticated()) {
    res.redirect('/');
  } else {
    res.render(page);
  }
}

// If the supplied result is succesful, the parameters and media items are
// cached.
// Helper method that returns and caches the result from a Library API search
// query returned by libraryApiSearch(...). If the data.error field is set,
// the data is handled as an error and not cached. See returnError instead.
// Otherwise, the media items are cached, the search parameters are stored
// and they are returned in the response.
function returnPhotos(res, userId, data, searchParameter) {
  if (data.error) {
    returnError(res, data)
  } else {
    // Remove the pageToken and pageSize from the search parameters.
    // They will be set again when the request is submitted but don't need to be
    // stored.
    delete searchParameter.pageToken;
    delete searchParameter.pageSize;

    // Cache the media items that were loaded temporarily.
    mediaItemCache.setItemSync(userId, data.photos);
    // Store the parameters that were used to load these images. They are used
    // to resubmit the query after the cache expires.
    storage.setItemSync(userId, {parameters: searchParameter});

    // Return the photos and parameters back int the response.
    res.status(200).send({photos: data.photos, parameters: searchParameter});
  }
}

// Responds with an error status code and the encapsulated data.error.
function returnError(res, data) {
  // Return the same status code that was returned in the error or use 500
  // otherwise.
  const statusCode = data.error.code || 500;
  // Return the error.
  res.status(statusCode).send(data.error);
}

// Constructs a date object required for the Library API.
// Undefined parameters are not set in the date object, which the API sees as a
// wildcard.
function constructDate(year, month, day) {
  const date = {};
  if (year) date.year = year;
  if (month) date.month = month;
  if (day) date.day = day;
  return date;
}

// Submits a search request to the Google Photos Library API for the given
// parameters. The authToken is used to authenticate requests for the API.
// The minimum number of expected results is configured in config.photosToLoad.
// This function makes multiple calls to the API to load at least as many photos
// as requested. This may result in more items being listed in the response than
// originally requested.
async function libraryApiSearch(authToken, parameters) {
  let photos = [];
  let nextPageToken = null;
  let error = null;

  parameters.pageSize = config.searchPageSize;

  try {
    // Loop while the number of photos threshold has not been met yet
    // and while there is a nextPageToken to load more items.
    do {
      logger.info(
          `Submitting search with parameters: ${JSON.stringify(parameters)}`);

      // Make a POST request to search the library or album
      const result =
          await request.post(config.apiEndpoint + '/v1/mediaItems:search', {
            headers: {'Content-Type': 'application/json'},
            json: parameters,
            auth: {'bearer': authToken},
          });

      logger.debug(`Response: ${result}`);

      // The list of media items returned may be sparse and contain missing
      // elements. Remove all invalid elements.
      // Also remove all elements that are not images by checking its mime type.
      // Media type filters can't be applied if an album is loaded, so an extra
      // filter step is required here to ensure that only images are returned.
      const items = result && result.mediaItems ?
          result.mediaItems
              .filter(x => x)  // Filter empty or invalid items.
              // Only keep media items with an image mime type.
              .filter(x => x.mimeType && x.mimeType.startsWith('image/')) :
          [];

      photos = photos.concat(items);

      // Set the pageToken for the next request.
      parameters.pageToken = result.nextPageToken;

      logger.verbose(
          `Found ${items.length} images in this request. Total images: ${
              photos.length}`);

      // Loop until the required number of photos has been loaded or until there
      // are no more photos, ie. there is no pageToken.
    } while (photos.length < config.photosToLoad &&
             parameters.pageToken != null);

  } catch (err) {
    // If the error is a StatusCodeError, it contains an error.error object that
    // should be returned. It has a name, statuscode and message in the correct
    // format. Otherwise extract the properties.
    error = err.error.error ||
        {name: err.name, code: err.statusCode, message: err.message};
    logger.error(error);
  }

  logger.info('Search complete.');
  return {photos, parameters, error};
}

// Returns a list of all albums owner by the logged in user from the Library
// API.
async function libraryApiGetAlbums(authToken) {
  let albums = [];
  let nextPageToken = null;
  let error = null;
  let parameters = {pageSize: config.albumPageSize};

  try {
    // Loop while there is a nextpageToken property in the response until all
    // albums have been listed.
    do {
      logger.verbose(`Loading albums. Received so far: ${albums.length}`);
      // Make a GET request to load the albums with optional parameters (the
      // pageToken if set).
      const result = await request.get(config.apiEndpoint + '/v1/albums', {
        headers: {'Content-Type': 'application/json'},
        qs: parameters,
        json: true,
        auth: {'bearer': authToken},
      });

      logger.debug(`Response: ${result}`);

      if (result && result.albums) {
        logger.verbose(`Number of albums received: ${result.albums.length}`);
        // Parse albums and add them to the list, skipping empty entries.
        const items = result.albums.filter(x => !!x);

        albums = albums.concat(items);
      }
      parameters.pageToken = result.nextPageToken;
      // Loop until all albums have been listed and no new nextPageToken is
      // returned.
    } while (parameters.pageToken != null);

  } catch (err) {
    // If the error is a StatusCodeError, it contains an error.error object that
    // should be returned. It has a name, statuscode and message in the correct
    // format. Otherwise extract the properties.
    error = err.error.error ||
        {name: err.name, code: err.statusCode, message: err.message};
    logger.error(error);
  }

  logger.info('Albums loaded.');
  return {albums, error};
}

// [END app]
