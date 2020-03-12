const mongoose = require('mongoose');

const constants = require('../helpers/constants').schemaTypes;
const aggregateHelper = require('../helpers/aggregators');

/**
 * Create an aggregation that sets the matching criteria for search.
 *
 * @param {string} schemaName Schema being searched on
 * @param {string} projectId Project ID
 * @param {string} keywords List of keywords to search on
 * @param {boolean} caseSensitive Case sensitive search?
 * @param {array} orModifier Search criteria for an 'or' search
 * @param {array} andModifier Search criteria for an 'and' search
 * @param {array} roles User's roles
 *
 * @returns {array} Aggregation for a match
 */
exports.createMatchAggr = async (schemaName, projectId, keywords, caseSensitive, orModifier, andModifier, roles) => {
  const aggregation = [];
  let projectModifier;
  let keywordModifier;

  if (projectId) {
    projectModifier = { project: mongoose.Types.ObjectId(projectId) };
  }

  if (keywords) {
    keywordModifier = { $text: { $search: keywords, $caseSensitive: caseSensitive } };
  }

  // query modifiers
  const andExpArray = await aggregateHelper.generateExpArray(andModifier, roles, schemaName);

  // filters
  const orExpArray = await aggregateHelper.generateExpArray(orModifier, roles, schemaName);

  let modifier = {};
  if (andExpArray.length > 0 && orExpArray.length > 0) {
    modifier = { $and: [{ $and: andExpArray }, { $or: orExpArray }] };
  } else if (andExpArray.length === 0 && orExpArray.length > 0) {
    modifier = { $and: orExpArray };
  } else if (andExpArray.length > 0 && orExpArray.length === 0) {
    modifier = { $and: andExpArray };
  }

  aggregation.push({
    $match: {
      _schemaName: schemaName,
      ...(aggregateHelper.isEmpty(modifier) ? undefined : modifier),
      ...(projectModifier ? projectModifier : undefined),
      ...(keywordModifier ? keywordModifier : undefined),
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false },
      ]
    }
  });

  // Check document permissions
  aggregation.push(
    {
      $redact: {
        $cond: {
          if: {
            // This way, if read isn't present, we assume public no roles array.
            $and: [
              { $cond: { if: '$read', then: true, else: false } },
              {
                $anyElementTrue: {
                  $map: {
                    input: '$read',
                    as: 'fieldTag',
                    in: { $setIsSubset: [['$$fieldTag'], roles] }
                  }
                }
              }
            ]
          },
          then: '$$KEEP',
          else: {
            $cond: { if: '$read', then: '$$PRUNE', else: '$$DESCEND' }
          }
        }
      }
    },
    {
      $addFields: {
        score: { $meta: 'textScore' }
      }
    }
  );

  return aggregation;
};

/**
 * Create an aggregation that sets the sorting and paging for a query.
 *
 * @param {string} schemaName Schema being searched on
 * @param {array} sortValues Values to sort by
 * @param {string} sortField Single field to sort by
 * @param {number} sortDirection Direction of sort
 * @param {number} pageNum Page number to offset results by
 * @param {number} pageSize Result set size
 *
 * @returns {array} Aggregation of sorting and paging
 */
exports.createSortingPagingAggr = function(schemaName, sortValues, sortField, sortDirection, pageNum, pageSize) {
  const searchResultAggregation = [];
  let datePostedHandlingTruncating = false;
  if (sortField && sortValues !=null && typeof sortValues != "undefined" && sortField.includes(",") || Object.keys(sortValues).length > 1){
    //sort will have multiple values passed
    if (sortField.includes("datePosted") || Object.prototype.hasOwnProperty.call(sortValues, "datePosted")){
      //datePosted is too specfic(in it's time) and needs the truncated form of date, can be expanded if other dates are required to be truncated
      tempSortValues = {};
      for (let property in sortValues){
        if (Object.prototype.hasOwnProperty.call(sortValues, property)) {
          if (property === "datePosted"){
            tempSortValues['date'] = sortValues[property];
          } else {
            tempSortValues[property] = sortValues[property];
          }
        }
      }
      sortValues = tempSortValues;
      datePostedHandlingTruncating = true;
    }

  } else {
    // if sortField is null, this would create a broken sort, so ignore it if its null
    if(sortField) {
      sortValues[sortField] = sortDirection;
    }
  }

  // We don't want to have sort in the aggregation if the front end doesn't need sort.
  if (sortField && sortDirection) {
     if(datePostedHandlingTruncating){
      // Currently this is just handling datePosted, if more date variables are needed change datePosted to a variable and detect it above
      searchResultAggregation.push(

        { $addFields: {
          'date':
            { $dateToString: {
              'format': '%Y-%m-%d', 'date': '$datePosted'
            }}

        }},
        { $sort: sortValues }
      );
    } else {
      searchResultAggregation.push(
        {
          $sort: sortValues
        }
      );
    }
  }

  searchResultAggregation.push(
    {
      $skip: pageNum * pageSize
    },
    {
      $limit: pageSize
    },
  );

  const combinedAggregation = [{
    $facet: {
      searchResults: searchResultAggregation,
      meta: [
        {
          $count: 'searchResultsTotal'
        }
      ]
    }
  }];

  return combinedAggregation;
};
