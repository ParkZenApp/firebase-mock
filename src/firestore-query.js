'use strict';

var _ = require('./lodash');
var Stream = require('stream');
var Promise = require('rsvp').Promise;
var autoId = require('firebase-auto-ids');
var FieldPath = require('./firestore-field-path');
var QuerySnapshot = require('./firestore-query-snapshot');
var DocumentSnapshot = require('./firestore-document-snapshot');
var Queue = require('./queue').Queue;
var utils = require('./utils');

function MockFirestoreQuery(path, data, parent, name) {
  this.errs = {};
  this.path = path || 'Mock://';
  this.id = parent ? name : extractName(path);
  this.flushDelay = parent ? parent.flushDelay : false;
  this.queue = parent ? parent.queue : new Queue();
  this.parent = parent || null;
  this.firestore = parent ? parent.firestore : null;
  this.children = {};
  this.orderedProperties = [];
  this.orderedDirections = [];
  this.limited = 0;
  this.buildStartFinder = function () { return function () { return true; }; };
  this._setData(data);
}

MockFirestoreQuery.prototype.flush = function (delay) {
  this.queue.flush(delay);
  return this;
};

MockFirestoreQuery.prototype.autoFlush = function (delay) {
  if (_.isUndefined(delay)) {
    delay = true;
  }
  if (this.flushDelay !== delay) {
    this.flushDelay = delay;
    _.forEach(this.children, function (child) {
      child.autoFlush(delay);
    });
    if (this.parent) {
      this.parent.autoFlush(delay);
    }
  }
  return this;
};

MockFirestoreQuery.prototype.getFlushQueue = function () {
  return this.queue.getEvents();
};

MockFirestoreQuery.prototype._setData = function (data) {
  this.data = utils.cleanFirestoreData(_.cloneDeep(data) || null);
};

MockFirestoreQuery.prototype._getData = function () {
  return _.cloneDeep(this.data);
};

MockFirestoreQuery.prototype.toString = function () {
  return this.path;
};

MockFirestoreQuery.prototype.get = function () {
  var err = this._nextErr('get');
  var self = this;
  return new Promise(function (resolve, reject) {
    self._defer('get', _.toArray(arguments), function () {
      var results = self._results();
      if (err === null) {
        if (_.size(self.data) !== 0) {
          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results));
        } else {
          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id)));
        }
      } else {
        reject(err);
      }
    });
  });
};

MockFirestoreQuery.prototype.stream = function () {
  var stream = new Stream.Transform({
    objectMode: true,
    transform: function (chunk, encoding, done) {
      this.push(chunk);
      done();
    }
  });

  this.get().then(function (snapshots) {
    snapshots.forEach(function (snapshot) {
      stream.write(snapshot);
    });
    stream.end();
  });

  return stream;
};

MockFirestoreQuery.prototype.where = function (property, operator, value) {
  var query = this.clone();
  var path = getPropertyPath(property);

  // check if unsupported operator
  if (operator !== '==' && operator !== 'array-contains' && operator !== 'in') {
    console.warn('Using unsupported where() operator for firebase-mock, returning entire dataset');
  } else {
    if (_.size(this.data) !== 0) {
      var results = {};
      _.forEach(this.data, function(data, key) {
        var queryable = { data: data, key: key };
        switch (operator) {
          case '==':
            if (_.isEqual(_.get(queryable, path), value)) {
              results[key] = _.cloneDeep(data);
            }
            break;
          case 'array-contains':
            if (_.includes(_.get(data, property), value)) {
              results[key] = _.cloneDeep(data);
            }
            break;
          case 'in':
            if (_.includes(value, _.get(data, property))) {
              results[key] = _.cloneDeep(data);
            }
            break;
          default:
            results[key] = _.cloneDeep(data);
            break;
        }
      });
      query._setData(results);
    } else {
      query._setData(null);
    }
  }

  return query;
};

MockFirestoreQuery.prototype.orderBy = function (property, direction) {
  var query = this.clone();

  query.orderedProperties.push(property);
  query.orderedDirections.push(direction || 'asc');

  return query;
};

MockFirestoreQuery.prototype.limit = function (limit) {
  var query = this.clone();
  query.limited = limit;
  return query;
};

MockFirestoreQuery.prototype.startAfter = function (doc) {
  if (!(doc instanceof DocumentSnapshot)) {
    console.warn('Using unsupported startAfter() parameter for firebase-mock, returning entire dataset');
    return this;
  }

  if (this.orderedProperties.length === 0) {
    throw new Error('Query must be ordered to paginate');
  }

  var query = this.clone();

  query.buildStartFinder = function () {
    var next = false;

    return function (data, key) {
      if (next) {
        return true;
      } else {
        next = key === doc.ref.id;
        return false;
      }
    };
  };

  return query;
};

MockFirestoreQuery.prototype.clone = function () {
  var query = new MockFirestoreQuery(this.path, this._getData(), this.parent, this.id);

  query.orderedProperties = Array.from(this.orderedProperties);
  query.orderedDirections = Array.from(this.orderedDirections);
  query.limited = this.limited;
  query.buildStartFinder = this.buildStartFinder;

  return query;
};

MockFirestoreQuery.prototype.onSnapshot = function (optionsOrObserverOrOnNext, observerOrOnNextOrOnError, onErrorArg) {
  var err = this._nextErr('onSnapshot');
  var self = this;
  var onNext = optionsOrObserverOrOnNext;
  var onError = observerOrOnNextOrOnError;
  var includeMetadataChanges = optionsOrObserverOrOnNext.includeMetadataChanges;

  if (includeMetadataChanges) {
    // Note this doesn't truly mimic the firestore metadata changes behavior, however
    // since everything is syncronous, there isn't any difference in behavior.
    onNext = observerOrOnNextOrOnError;
    onError = onErrorArg;
  }
  var context = {
    data: self._results(),
  };
  var onSnapshot = function (initialCall) {
    // compare the current state to the one from when this function was created
    // and send the data to the callback if different.
    if (err === null) {
      if (initialCall) {
        const results = self._results();
        if (_.size(self.data) !== 0) {
          onNext(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results, {}));
        } else {
          onNext(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id)));
        }
      } else {
        self.get().then(function (querySnapshot) {
          var results = self._results();
          if (!_.isEqual(results, context.data) || includeMetadataChanges) {
            onNext(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results, context.data));
            context.data = results;
          }
        });
      }
    } else {
      onError(err);
    }
  };

  // onSnapshot should always return when initially called, then
  // every time data changes.
  onSnapshot(true);
  var unsubscribe = this.queue.onPostFlush(onSnapshot);

  // return the unsubscribe function
  return unsubscribe;
};

MockFirestoreQuery.prototype._results = function () {
  var results = {};
  var limit = 0;
  var atStart = false;
  var atEnd = false;
  var startFinder = this.buildStartFinder();

  var inRange = function(data, key) {
    if (atEnd) {
      return false;
    } else if (atStart) {
      return true;
    } else {
      atStart = startFinder(data, key);
      return atStart;
    }
  };
  if (_.size(this.data) === 0) {
    return results;
  }


  var self = this;
  if (this.orderedProperties.length === 0) {
    _.forEach(this.data, function(data, key) {
      if (inRange(data, key) && (self.limited <= 0 || limit < self.limited)) {
        results[key] = _.cloneDeepWith(data, utils.cloneCustomizer);
        limit++;
      }
    });
  } else {
    var queryable = [];
    _.forEach(self.data, function(data, key) {
      queryable.push({
        data: data,
        key: key
      });
    });

    var orderBy = _.map(self.orderedProperties, getPropertyPath);
    queryable = _.orderBy(queryable, orderBy, self.orderedDirections);
    queryable.forEach(function(q) {
      if (inRange(q.data, q.key) && (self.limited <= 0 || limit < self.limited)) {
        results[q.key] = _.cloneDeepWith(q.data, utils.cloneCustomizer);
        limit++;
      }
    });
  }

  return results;
};

MockFirestoreQuery.prototype._defer = function (sourceMethod, sourceArgs, callback) {
  this.queue.push({
    fn: callback,
    context: this,
    sourceData: {
      ref: this,
      method: sourceMethod,
      args: sourceArgs
    }
  });
  if (this.flushDelay !== false) {
    this.flush(this.flushDelay);
  }
};

MockFirestoreQuery.prototype._nextErr = function (type) {
  var err = this.errs[type];
  delete this.errs[type];
  return err || null;
};

function extractName(path) {
  return ((path || '').match(/\/([^.$\[\]#\/]+)$/) || [null, null])[1];
}

function getPropertyPath(p) {
  if (FieldPath.documentId().isEqual(p)) {
    return 'key';
  } else if (p instanceof FieldPath) {
    return 'data.' + p._path.join('.');
  } else {
    return 'data.' + p;
  }
}

module.exports = MockFirestoreQuery;
