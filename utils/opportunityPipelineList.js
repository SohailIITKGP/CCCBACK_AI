const Opportunity = require("../models/Opportunity");
const {
  parsePositiveInt,
  buildSearchFilterOnlyClauses,
} = require("./opportunityListPaginate");

/** Current-status tags that qualify an opportunity for the Pipeline view. */
const PIPELINE_STATUSES = [
  "Property is ok - Negotiate Rent",
  "Property Approved but Board Approval Pending",
  "Property Approved",
  "Site Visit Done",
  "Loi Singed",
  "Loi Received",
  "Commercial Details Shared",
];

function buildFirstMatch(role, userId, extraClauses) {
  const base = { isVisibility: true };
  if (role === "Lead-Employee") {
    base.whoLinkthis = userId;
  }
  if (!extraClauses || !extraClauses.length) {
    return { $match: base };
  }
  return { $match: { $and: [base, ...extraClauses] } };
}

function buildDateMatchStage(startDate, endDate) {
  if (!startDate && !endDate) return null;
  return {
    $match: {
      $or: [
        {
          firstPipelineEntryDate: {
            ...(startDate && { $gte: new Date(startDate) }),
            ...(endDate && {
              $lte:
                startDate === endDate
                  ? new Date(new Date(endDate).setHours(23, 59, 59, 999))
                  : new Date(endDate),
            }),
          },
        },
        {
          firstPipelineEntryDate: null,
          createdAt: {
            ...(startDate && { $gte: new Date(startDate) }),
            ...(endDate && {
              $lte:
                startDate === endDate
                  ? new Date(new Date(endDate).setHours(23, 59, 59, 999))
                  : new Date(endDate),
            }),
          },
        },
      ],
    },
  };
}

function buildAggregationPipeline(role, userId, startDate, endDate, extraClauses) {
  const pipelineStatuses = PIPELINE_STATUSES;

  const pipeline = [
    buildFirstMatch(role, userId, extraClauses),
    {
      $addFields: {
        firstPipelineEntryDate: {
          $let: {
            vars: {
              pipelineComments: {
                $filter: {
                  input: "$commentsSection",
                  cond: { $in: ["$$this.tag", pipelineStatuses] },
                },
              },
            },
            in: {
              $cond: {
                if: { $gt: [{ $size: "$$pipelineComments" }, 0] },
                then: {
                  $min: "$$pipelineComments.createdAt",
                },
                else: null,
              },
            },
          },
        },
      },
    },
    {
      $match: {
        status: { $in: pipelineStatuses },
      },
    },
  ];

  const dateStage = buildDateMatchStage(startDate, endDate);
  if (dateStage) pipeline.push(dateStage);

  pipeline.push(
    {
      $sort: {
        firstPipelineEntryDate: -1,
        createdAt: -1,
      },
    },
    {
      $lookup: {
        from: "clients",
        localField: "client",
        foreignField: "_id",
        as: "client",
      },
    },
    { $unwind: "$client" },
    {
      $lookup: {
        from: "users",
        localField: "whoLinkthis",
        foreignField: "_id",
        as: "whoLinkthis",
        pipeline: [{ $project: { name: 1, role: 1 } }],
      },
    },
    {
      $unwind: { path: "$whoLinkthis", preserveNullAndEmptyArrays: true },
    },
    {
      $lookup: {
        from: "users",
        localField: "verifiedProposalBy",
        foreignField: "_id",
        as: "verifiedProposalBy",
        pipeline: [{ $project: { name: 1, role: 1 } }],
      },
    },
    {
      $unwind: { path: "$verifiedProposalBy", preserveNullAndEmptyArrays: true },
    },
    {
      $lookup: {
        from: "users",
        localField: "proposalEmailSentBy",
        foreignField: "_id",
        as: "proposalEmailSentBy",
        pipeline: [{ $project: { name: 1, role: 1 } }],
      },
    },
    {
      $unwind: { path: "$proposalEmailSentBy", preserveNullAndEmptyArrays: true },
    },
    {
      $lookup: {
        from: "users",
        localField: "commentsSection.whoCommented",
        foreignField: "_id",
        as: "commentUsers",
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $addFields: {
        commentsSection: {
          $map: {
            input: "$commentsSection",
            as: "comment",
            in: {
              $mergeObjects: [
                "$$comment",
                {
                  whoCommented: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: "$commentUsers",
                          cond: { $eq: ["$$this._id", "$$comment.whoCommented"] },
                        },
                      },
                      0,
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },
    { $unset: "commentUsers" }
  );

  if (role === "BO-Client" || role === "Lead-Employee") {
    pipeline.push(
      {
        $lookup: {
          from: "properties",
          localField: "property",
          foreignField: "_id",
          as: "property",
          pipeline: [
            {
              $project: {
                name: 1,
                owner: 1,
                propertySourceName: 1,
                shopNo: 1,
                lumsumRent: 1,
                city: 1,
                clusters: 1,
                docklevelnoQty: 1,
                fireSafety: 1,
                washroomQty: 1,
                floorStrength: 1,
                roadName: 1,
                category: 1,
                pinPointLocation: 1,
                floor: 1,
                area: 1,
                isRead: 1,
                exactArea: 1,
                height: 1,
                frontageRoad: 1,
                expectedRent: 1,
                rentType: 1,
                possession: 1,
                nearestBrandImage: 1,
                roadmap: 1,
                linkedClients: 1,
                opportunities: 1,
                createdAt: 1,
                updatedAt: 1,
                isVisibility: 1,
                isArchive: 1,
                whoCreated: 1,
                whoLinkthis: 1,
              },
            },
          ],
        },
      },
      { $unwind: "$property" }
    );
  } else {
    pipeline.push(
      {
        $lookup: {
          from: "properties",
          localField: "property",
          foreignField: "_id",
          as: "property",
        },
      },
      { $unwind: "$property" }
    );
  }

  if (role === "Product-Manager") {
    pipeline.push({
      $project: {
        "client.name": 0,
        "client.email": 0,
        "client.contactDetails": 0,
        "client.contactPerson": 0,
        "client.owner": 0,
        "client.designation": 0,
        loaDetails: 0,
        agreementDetails: 0,
        "property.propertyImages": 0,
        "property.insideViewImage": 0,
        "property.brochurePdf": 0,
        "property.planLayoutImage": 0,
        "property.address": 0,
        "property.contact": 0,
        "property.owner": 0,
      },
    });
  }

  if (role === "BO-Client" || role === "Lead-Employee") {
    pipeline.push({
      $project: {
        propertyImages: 0,
        insideViewImage: 0,
        brochurePdf: 0,
        planLayoutImage: 0,
        "property.propertyImages": 0,
        "property.insideViewImage": 0,
        "property.brochurePdf": 0,
        "property.planLayoutImage": 0,
        "property.address": 0,
        "property.contact": 0,
        "property.owner": 0,
      },
    });
  } else {
    pipeline.push({
      $project: {
        propertyImages: 0,
        insideViewImage: 0,
        brochurePdf: 0,
        planLayoutImage: 0,
      },
    });
  }

  return pipeline;
}

async function queryPipelineOpportunitiesList(req) {
  const role = req.user.role;
  const userId = req.user._id;
  if (
    role !== "Super Admin" &&
    role !== "Manager" &&
    role !== "BO-Client" &&
    role !== "Lead-Employee" &&
    role !== "Product-Manager"
  ) {
    return { denied: true };
  }

  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 25, 100);
  const skip = (page - 1) * limit;

  const { startDate, endDate } = req.query;
  const extraClauses = await buildSearchFilterOnlyClauses(req);

  const pipeline = buildAggregationPipeline(
    role,
    userId,
    startDate,
    endDate,
    extraClauses
  );

  pipeline.push(
    {
      $facet: {
        meta: [{ $count: "total" }],
        rows: [{ $skip: skip }, { $limit: limit }],
      },
    },
    {
      $project: {
        total: {
          $ifNull: [
            {
              $let: {
                vars: { m: { $arrayElemAt: ["$meta", 0] } },
                in: "$$m.total",
              },
            },
            0,
          ],
        },
        data: "$rows",
      },
    }
  );

  const agg = await Opportunity.aggregate(pipeline);
  const doc = agg[0] || { data: [], total: 0 };
  const total = typeof doc.total === "number" ? doc.total : 0;
  const data = Array.isArray(doc.data) ? doc.data : [];
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    denied: false,
    data,
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}

module.exports = {
  queryPipelineOpportunitiesList,
  PIPELINE_STATUSES,
};
