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

// Submits a request to load images from a search with filters.
// The entire form is sent to the backend, where the options set here
// are converted into filters and parameters for a search request for the
// Library API.
function importFilter(filter) {
  $.ajax({
    type: 'POST',
    url: '/loadFromSearch',
    dataType: 'json',
    data: filter,
    success: (data) => {
      console.log('Loaded photos successfully.');
      if (data.photos && data.photos.length > 0) {
        // If the request was successful and images were loaded,
        // go back to the preview screen that shows the grid of images queued
        // for display.
        window.location = '/';
      } else {
        handleError('No images found', 'Try different search parameters.');
      }
      hideLoadingDialog();
    },
    error: (data) => {
      handleError('Couldn\'t load images.', data);
    },
  });
}

$(document).ready(() => {
  // Show date filter options based on which date filter type is selected.
  $('input[name$=\'dateFilter\']').on('click', (e) => {
    const range = '#rowDateRange';
    const exact = '#rowDateExact';

    switch ($(e.currentTarget).val()) {
      case 'none':
        $(range).hide();
        $(exact).hide();
        break;
      case 'exact':
        $(range).hide();
        $(exact).show();
        break;

      case 'range':
        $(range).show();
        $(exact).hide();
        break;
    }
  });

  // When the filter form is submitted, serialize its contents, show the loading
  // dialog and submit the request to the backend.
  $('#filter').on('submit', (e) => {
    e.preventDefault();
    showLoadingDialog();
    importFilter($('#filter').serialize())
  });
});