/**
 * Module dependencies
 */

var actionUtil = require('../actionUtil');
var _ = require('@sailshq/lodash');
var async = require('async');

/**
 * Replace Records in Collection
 *
 * http://sailsjs.com/docs/reference/blueprint-api/replace
 *
 * Replace the associated records in the given collection with
 * different records.  For example, replace all of a user's pets.
 *
 */

module.exports = function replaceCollection (req, res) {

  // Ensure a model and alias can be deduced from the request.
  var Model = actionUtil.parseModel(req);
  var relation = req.options.alias;
  if (!relation) {
    return res.serverError(new Error('Missing required route option, `req.options.alias`.'));
  }

  // The primary key of the parent record
  var parentPk = req.param('parentid');

  var childPks = _.isArray(req.body) ? req.body : req.query[relation];

  if (_.isString(childPks)) {
    try {
      childPks = JSON.parse(childPks);
    } catch (e) {
      return res.badRequest(new Error('Invalid values for `' + relation + '` collection given to "replace" blueprint action.  If specified as a string, the value must be parseable as a JSON array, e.g. "[1,2]".'));
    }
  }

  var removedFromNotificationsToSend = [];
  var existingChildPks = [];

  // Get the relevant association attribute on the parent model.
  var attr = Model.attributes[relation];

  // Get the related ("child") model.
  var relatedModel = req._sails.models[attr.model || attr.collection];

  // Get the inverse attribute (if any) on the related model.
  var inverseAttr = attr.via && relatedModel.attributes[attr.via];

  async.auto({

    // If this is a many-to-one relationship, get all of the existing child PKs so that we can
    // inform them of their removal (if they're not in the new set), and get all of the parent PKs
    notificationsForExistingParentsOfReplacementChildren: function(cb) {

      // If there is no inverse attribute on the related model, then this is a via-less collection
      // which uses an implicit join table, so there's no "stealing" of children.
      if (!inverseAttr) { return cb(); }

      // If the inverse relationship on the related model is a collection, then this is
      // a many-to-many relationship, so again, no stolen children.
      if (inverseAttr.collection) { return cb(); }

      // Ok, this is a many-to-one relationship, so let's find all of the "replacement" children
      // and add `removedFrom` notifications for each (if the current parent is different from the new parent).
      var criteria = {};
      criteria[relatedModel.primaryKey] = childPks;
      criteria[attr.via] = {'!=': parentPk};
      relatedModel.stream(criteria).select([attr.via]).eachRecord(function(childRecord, nextChild) {

        if (childRecord[attr.via] !== null) {
          removedFromNotificationsToSend.push({
            id: childRecord[attr.via],
            removedId: childRecord[relatedModel.primaryKey],
            attribute: relation,
            reverse: false
          });
        }

        return nextChild();

      }).exec(cb);

    },

    notificationsForExistingChildrenOfParent: function(cb) {

      // If this is a many-to-many or a via-less relationship, then we can't query the related model
      // to find the existing children of our parent.  We'll have to just do a find + populate.
      if (!inverseAttr || inverseAttr.collection) {

        var parentCriteria = {};
        parentCriteria[Model.primaryKey] = parentPk;
        var populateCriteria = {
          select: [relatedModel.primaryKey]
        };
        Model.findOne(parentCriteria).populate('patients', populateCriteria).exec(function(err, parentRecord) {
          if (err) {return cb(err);}
          _.each(parentRecord[relation], function(child) {
            existingChildPks.push(child[relatedModel.primaryKey]);
            if (!_.contains(childPks, child[relatedModel.primaryKey])) {
              removedFromNotificationsToSend.push({
                id: parentPk,
                removedId: child[relatedModel.primaryKey],
                attribute: relation,
                reverse: true
              });
            }
          });
          return cb();
        });

        return;
      }

      // Otherwise, this is a many-to-one relationship, and we can query the related model.
      var criteria = {
        where: {},
        select: [relatedModel.primaryKey]
      };
      criteria.where[attr.via] = parentPk;
      relatedModel.stream(criteria).eachRecord(function(childRecord, nextChild) {
        existingChildPks.push(childRecord[relatedModel.primaryKey]);
        if (!_.contains(childPks, childRecord[relatedModel.primaryKey])) {
          removedFromNotificationsToSend.push({
            id: parentPk,
            removedId: childRecord[relatedModel.primaryKey],
            attribute: relation,
            reverse: true
          });
        }

        return nextChild();

      }).exec(cb);

    }


  }, function(err) {

    if (err) {
      return res.serverError(err);
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // FUTURE: Use a database transaction here, if all of the involved models
    // are using the same datastore, and if that datastore supports transactions.
    // e.g.
    // ```
    // Model.getDatastore().transaction(function during(db, proceed){ ... })
    // .exec(function afterwards(err, result){}));
    // ```
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    Model.replaceCollection(parentPk, relation, childPks).exec( function(err) {

      if (err) {
        // If this is a usage error coming back from Waterline,
        // (e.g. a bad criteria), then respond w/ a 400 status code.
        // Otherwise, it's something unexpected, so use 500.
        switch (err.name) {
          case 'UsageError': return res.badRequest(err);
          default: return res.serverError(err);
        }
      }

      // Broadcast updates to subscribers of the child records.
      if (req._sails.hooks.pubsub) {

        // Subscribe to the model you're adding to, if this was a socket request
        if (req.isSocket) { Model.subscribe(req, [parentPk]); }

        // Publish to subscribed sockets
        _.each(_.difference(childPks, existingChildPks), function(childPk) {
          Model._publishAdd(parentPk, relation, childPk, !req.options.mirror && req);
        });

        if (removedFromNotificationsToSend.length) {
          _.each(removedFromNotificationsToSend, function(notification) {
            Model._publishRemove(notification.id, notification.attribute, notification.removedId, !req.options.mirror && req, {noReverse: !notification.reverse});
          });
        }

      }

      var query = Model.findOne(parentPk);
      query = actionUtil.populateRequest(query, req);
      query.exec(function(err, matchingRecord) {
        if (err) { return res.serverError(err); }
        if (!matchingRecord) { return res.serverError(); }
        if (!matchingRecord[relation]) { return res.serverError(); }
        return res.ok(matchingRecord);
      });

    }); // </ Model.replaceCollection(parentPk)>

  });


};