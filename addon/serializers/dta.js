import DS from 'ember-data';
import Ember from 'ember';

export default DS.RESTSerializer.extend(DS.EmbeddedRecordsMixin, {

  isNewSerializerAPI: true,

  keyForAttribute: function(attr) {
    return Ember.String.underscore(attr);
  },

  keyForRelationship: function(key) {
    return Ember.String.decamelize(key);
  },

  normalizeResponse: function (store, primaryModelClass, payload, id, requestType) {
    let convertedPayload = {};

    if (!Ember.isNone(payload) &&
      payload.hasOwnProperty('meta') &&
      payload.hasOwnProperty('objects')) {
      convertedPayload[primaryModelClass.modelName] = JSON.parse(JSON.stringify(payload.objects));
      delete payload.results;
      convertedPayload['meta'] = JSON.parse(JSON.stringify(payload.meta));
    } else {
      //Ember.assert("Received objects array without meta", !payload.hasOwnProperty('objects'));
      convertedPayload[primaryModelClass.modelName] = JSON.parse(JSON.stringify(payload));
    }

    return this._super(store, primaryModelClass, convertedPayload, id, requestType);
  },
  /**
    `extractMeta` is used to deserialize any meta information in the
    adapter payload. By default Ember Data expects meta information to
    be located on the `meta` property of the payload object.

    The actual nextUrl is being stored. The offset must be extracted from
    the string to do a new call.
    When there are remaining objects to be returned, Tastypie returns a
    `next` URL that in the meta header. Whenever there are no
    more objects to be returned, the `next` paramater value will be null.
    Instead of calculating the next `offset` each time, we store the nextUrl
    from which the offset will be extrated for the next request

    @method extractMeta
    @param {DS.Store} store
    @param {subclass of DS.Model} typeClass
    @param {Object} payload
  */
  extractMeta: function (store, typeClass, payload) {
    if (payload && payload.meta) {
      var adapter = store.adapterFor(typeClass.modelName);

      if (adapter && adapter.get('since') !== null && payload.meta[adapter.get('since')] !== undefined) {
        payload.meta.since = payload.meta[adapter.get('since')];
      }

      return payload.meta;
    }
  },

  extractMany: function(loader, json, type, records) {
    this.sideload(loader, type, json);
    this.extractMeta(loader, type, json);

    if (json.objects) {
      var objects = json.objects, references = [];
      if (records) { records = records.toArray(); }

      for (var i = 0; i < objects.length; i++) {
        if (records) { loader.updateId(records[i], objects[i]); }
        var reference = this.extractRecordRepresentation(loader, type, objects[i]);
        references.push(reference);
      }

      loader.populateArray(references);
    }
  },

  // Tastypie defaults do not support sideloading
  sideload: function() {
  },

  resourceUriToId: function (resource) {
    var resourceUri = typeof resource === 'string' ? resource : resource.resource_uri;
    return resourceUri.split('/').reverse()[1];
  },

  normalizeId: function (hash) {
    if (hash.resource_uri) {
      hash.id = this.resourceUriToId(hash.resource_uri);
      delete hash.resource_uri;
    }
  },


  extractRelationships: function (type, hash) {
  var payloadKey, self = this;
    type.eachRelationship(function (key, relationship) {
      if (this.keyForRelationship) {
        payloadKey = this.keyForRelationship(key, relationship.kind);
        if (key !== payloadKey) {
          hash[key] = hash[payloadKey];
          delete hash[payloadKey];
        }
      }
      if (hash[key]) {
        var isEmbedded = self.isEmbedded(relationship);
        if (relationship.kind === 'belongsTo'){
          var resourceUri = hash[key];
          if (!isEmbedded) {
            Ember.assert(relationship.key + " is an async relation but the related data in the response is not a URI", typeof resourceUri === "string");
          }
            hash[key] = self.resourceUriToId(hash[key]);
        } else if (relationship.kind === 'hasMany'){
          var ids = [];
          hash[key].forEach(function (resourceUri){
            if (!isEmbedded) {
              Ember.assert(relationship.key + " is an async relation but the related data in the response is not a URI", typeof resourceUri === "string");
            }
            ids.push(self.resourceUriToId(resourceUri));
          });
          hash[key] = ids;
        }
      }
    }, this);

    return this._super(type, hash);
  },

  normalizeArrayResponse: function (store, typeClass, payload, id, requestType) {
    this.extractEmbeddedFromArray(store, typeClass, payload);
    return this._super(store, typeClass, payload, id, requestType);
  },

  extractEmbeddedFromArray: function (store, typeClass, payload) {
    var self = this;
    payload[typeClass.modelName].forEach(function (data) {
      self.extractEmbeddedFromPayload(store, typeClass, data);
    });
  },

  normalizeSingleResponse: function(store, typeClass, payload, id, requestType) {
    this.extractEmbeddedFromPayload(store, typeClass, payload);
    return this._super(store, typeClass, payload, id, requestType);
  },

  isEmbedded: function(relationship) {
    var key = relationship.key;
    var attrs = Ember.get(this, 'attrs');
    var config = attrs && attrs[key] ? attrs[key] : false;
    if (config) {
        // Per model serializer will take preference for the embedded mode
        return (config.embedded === 'load' || config.embedded === 'always');
    }

    // Consider the resource as embedded if the relationship is not async
    return !(relationship.options.hasOwnProperty('async') ? relationship.options.async : true);
  },

  isResourceUri: function(adapter, payload) {
    if (typeof payload !== 'string') {
      return false;
    }
    return true;
  },

  extractEmbeddedFromPayload: function(store, type, payload) {
    var self = this;

    type.eachRelationship(function(key, relationship) {
      var attrs = Ember.get(self, 'attrs');
      var config = attrs && attrs[key] ? attrs[key] : false;

      if (self.isEmbedded(relationship)) {
        if (relationship.kind === 'hasMany') {
          self.extractEmbeddedFromHasMany(store, key, relationship, payload, type, config);
        } else if (relationship.kind === 'belongsTo') {
          self.extractEmbeddedFromBelongsTo(store, key, relationship, payload, type, config);
        }
      }
    });
  },

  extractEmbeddedFromHasMany: function(store, key, relationship, payload, config) {
    var serializer = store.serializerFor(relationship.type);

    key = config.key ? config.key : this.keyForAttribute(key);

    var ids = [];

    if (!payload[key]) {
      return;
    }

    payload[key].forEach((data) => {
      var embeddedType = store.modelFor(relationship.type);

      serializer.extractEmbeddedFromPayload(store, embeddedType, data);

      data = serializer.normalize(embeddedType, data, embeddedType.modelName);

      ids.push(serializer.relationshipToResourceUri(relationship, data.data, store));
      store.push(data);
    });

    payload[key] = ids;
  },

  extractEmbeddedFromBelongsTo: function(store, key, relationship, payload, type, config) {
    var serializer = store.serializerFor(relationship.type);

    key = config.key ? config.key : this.keyForAttribute(key);

    if (!payload[key]) {
      return;
    }

    var data = payload[key];

    // Don't try to process data if it's not data!
    if (serializer.isResourceUri(store.adapterFor(relationship.type), data)) {
      return;
    }

    var embeddedType = store.modelFor(relationship.type);

    serializer.extractEmbeddedFromPayload(store, embeddedType, data);

    data = serializer.normalize(embeddedType, data, embeddedType.modelName);
    store.push(data);
    payload[key] = serializer.relationshipToResourceUri(relationship, data.data, store);
  },

  relationshipToResourceUri: function (relationship, value, store){
    if (!value) {
      return value;
    }

    return store.adapterFor(relationship.type).buildURL(Ember.String.camelize(relationship.type), Ember.get(value, 'id'));
  },

  serializeIntoHash: function (data, type, record, options) {
    Ember.merge(data, this.serialize(record, options));
  },

  serializeBelongsTo: function (snapshot, json, relationship) {
    this._super.apply(this, arguments);
    var key = relationship.key;
    key = this.keyForRelationship ? this.keyForRelationship(key, "belongsTo") : key;

    json[key] = this.relationshipToResourceUri(relationship, snapshot.belongsTo(relationship.key), snapshot.record.store);
  },

  serializeHasMany: function(snapshot, json, relationship) {
    var key = relationship.key;
    key = this.keyForRelationship ? this.keyForRelationship(key, "hasMany") : key;

    var relationshipType = snapshot.type.determineRelationshipType(relationship, this.store);

    if (relationshipType === 'manyToNone' || relationshipType === 'manyToMany' || relationshipType === 'manyToOne') {
      if (this.isEmbedded(relationship)) {
        if (snapshot.hasMany(relationship.key)) {
          json[key] = snapshot.hasMany(relationship.key).map(function (embeddedSnapshot) {
            var data = embeddedSnapshot.record.serialize({includeId: true});
            return data;
          });
        } else {
          json[key] = [];
        }
      } else {
        var relationData = snapshot.hasMany(relationship.key);

        // We can't deal with promises here. We need actual data
        if (relationData instanceof DS.PromiseArray) {
          // We need the content of the promise. Make sure it is fulfilled
          if (relationData.get('isFulfilled')) {
            // Use the fulfilled array
            relationData = relationData.get('content');
          } else {
            // If the property hasn't been fulfilled then it hasn't changed.
            // Fall back to the internal data. It contains enough for relationshipToResourceUri.
            relationData = snapshot.hasMany(relationship.key).mapBy('id').map(function(_id) {
              return {id: _id};
            }) || [];
          }
        }

        json[key] = relationData.map(function (next){
          return this.relationshipToResourceUri(relationship, next, this.store);
        }, this);

      }
    }
  }
});
