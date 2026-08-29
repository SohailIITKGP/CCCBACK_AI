const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const User = require("../models/User");
const { sendProposalToClient } = require("../services/opportunityProposalService");
const { logDataAction } = require("../utils/auditLogger");
const dotenv = require('dotenv');
dotenv.config();

exports.calender = async (req, res) => {
    try {
        const userRole = req.user.role;
        const userId = req.user._id;
        
        let query = { isVisibility: true };
        
        // For BO-Client or Lead-Employee, only show events where they are the commenter
        if (userRole === "BO-Client" || userRole === "Lead-Employee") {
          query = {
            isVisibility: true,
            "commentsSection.whoCommented": userId
          };
        }
        
        const opportunities = await Opportunity.find(query)
          .populate("client", "name")
          .populate("property", "name")
          .populate("commentsSection.whoCommented", "name")
          .lean();  
    
        const events = [];
    
        for (const opportunity of opportunities) {
          if (!opportunity.commentsSection?.length) continue;
    
          for (const comment of opportunity.commentsSection) {
            if (!comment) continue;
            
            // For BO-Client or Lead-Employee, only include their own comments
            if ((userRole === "BO-Client" || userRole === "Lead-Employee")) {
              if (!comment.whoCommented) continue;
              
              const commentUserId = comment.whoCommented._id ? comment.whoCommented._id.toString() : comment.whoCommented.toString();
              const currentUserId = userId.toString();
              
              if (commentUserId !== currentUserId) continue;
            }
            
            const clientName = opportunity.client?.name || "Client";
            const propertyName = opportunity.property?.name || "Property";
    
            const followupDate = comment.followup?.date;
            if (followupDate && comment.followup.isDone === false) {
              events.push({
                title: `Follow-up for ${clientName}`,
                date: new Date(followupDate),  
                type: "Follow-Up",
                opportunityId: opportunity._id.toString(),
                commentId: comment._id.toString(),
                clientName,
                propertyName,
                isDone: false,
              });
            }
    
            // Handle site visit date  
            const sitevisitDate = comment.sitevisit?.date;
            if (sitevisitDate && comment.sitevisit.isDone === false) {
              events.push({
                title: `Site Visit for ${clientName}`,
                date: new Date(sitevisitDate), // Ensure proper date conversion
                type: "Site Visit", 
                opportunityId: opportunity._id.toString(),
                commentId: comment._id.toString(),
                clientName,
                propertyName,
                isDone: false,
              });
            }
          }
        }
    
        res.status(200).json(events);
    
      } catch (error) {
        console.error("Error fetching calendar events:", error);
        res.status(500).json({
          message: "Failed to fetch calendar events",
          error: error.message || "Unknown error occurred"
        });
      }
}



exports.markEventAsDone = async (req, res) => {
  try {
    const { opportunityId, commentId, eventType } = req.params;
    
    if (!opportunityId || !commentId || !eventType) {
      return res.status(400).json({
        success: false,
        message: "Opportunity ID, Comment ID, and Event Type are required"
      });
    }

    if (eventType !== 'sitevisit' && eventType !== 'followup') {
      return res.status(400).json({
        success: false,
        message: "Event Type must be either 'sitevisit' or 'followup'"
      });
    }

    // Find the opportunity
    const opportunity = await Opportunity.findById(opportunityId);
    
    if (!opportunity) {
      return res.status(404).json({
        success: false,
        message: "Opportunity not found"
      });
    }

    // Find the specific comment in the commentsSection array
    const commentIndex = opportunity.commentsSection.findIndex(
      comment => comment._id.toString() === commentId
    );

    if (commentIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Comment not found in this opportunity"
      });
    }

    // Check if the specific event exists and is not already marked as done
    if (eventType === 'sitevisit') {
      if (!opportunity.commentsSection[commentIndex].sitevisit || 
          opportunity.commentsSection[commentIndex].sitevisit.isDone === true) {
        return res.status(400).json({
          success: false,
          message: "Site visit is either already marked as done or doesn't exist"
        });
      }
      opportunity.commentsSection[commentIndex].sitevisit.isDone = true;
    } else if (eventType === 'followup') {
      if (!opportunity.commentsSection[commentIndex].followup || 
          opportunity.commentsSection[commentIndex].followup.isDone === true) {
        return res.status(400).json({
          success: false,
          message: "Follow-up is either already marked as done or doesn't exist"
        });
      }
      opportunity.commentsSection[commentIndex].followup.isDone = true;
    }
    
    // Save the updated opportunity
    await opportunity.save();

    // Mark linked follow-up task(s) as completed.
    try {
      const { completeTaskBySource } = require("../services/followUpTaskService");
      const { logFieldChange, formatTaskEntityName } = require("../utils/auditLogger");
      const FollowUpTask = require("../models/FollowUpTask");
      const mappedType = eventType === "sitevisit" ? "site_visit" : "follow_up";

      const pendingTasks = await FollowUpTask.find({
        opportunity: opportunityId,
        commentId,
        taskType: mappedType,
        status: "Pending",
      }).lean();

      await completeTaskBySource({
        opportunityId,
        commentId,
        taskType: mappedType,
        userId: req.user?._id,
      });

      for (const task of pendingTasks) {
        logFieldChange(req, {
          resource: "Task",
          resourceId: task._id,
          entityName: formatTaskEntityName(task),
          field: "status",
          from: "Pending",
          to: "Completed",
          extra: {
            taskType: mappedType,
            via: "markEventAsDone",
            eventType,
          },
        }).catch(() => {});
      }
    } catch (taskErr) {
      console.error("Failed to complete linked follow-up task:", taskErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `${eventType === 'sitevisit' ? 'Site visit' : 'Follow-up'} marked as done successfully`
    });
    
  } catch (error) {
    console.error(`Error marking ${req.params.eventType || 'event'} as done:`, error);
    return res.status(500).json({
      success: false,
      message: "Failed to mark event as done",
      error: error.message || "Unknown error occurred"
    });
  }
};
 

exports.sendProposalMail = async (req, res) => {
  const { opportunityId } = req.params;
  const userId = req.user._id;

  try {
    const opportunity = await Opportunity.findById(opportunityId).select("verifiedProposal");

    if (!opportunity) {
      return res.status(404).json({
        success: false,
        message: "Opportunity not found",
      });
    }

    if (!opportunity.verifiedProposal) {
      return res.status(400).json({
        success: false,
        message: "Proposal not verified",
      });
    }

    const result = await sendProposalToClient({
      opportunityId,
      actorUserId: userId,
      source: "manual",
      skipIfAlreadySent: false,
    });

    if (result.error) {
      return res.status(500).json({
        success: false,
        message: result.message || "Failed to send proposal mail",
        error: result.error,
      });
    }

    logDataAction(req, {
      action: "data_update",
      resource: "Opportunity",
      resourceId: opportunityId,
      details: { action: "proposal_sent", source: "manual" },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Proposal mail sent successfully",
    });
  } catch (error) {
    console.error("Error sending proposal mail:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send proposal mail",
      error: error.message || "Unknown error occurred",
    });
  }
};


exports.verifyProposal = async (req, res) => {
  const { opportunityId } = req.params;
  const user = req.user;
  const userId = user._id;

  try {
    const opportunity = await Opportunity.findById(opportunityId)
      .populate("client", "name")
      .populate("property", "name");

    if (!opportunity) {
      return res.status(404).json({
        success: false,
        message: "Opportunity not found"
      });
    }

    // Check if the proposal is already verified  
    if (opportunity.verifiedProposal) {
      return res.status(400).json({
        success: false,
        message: "Proposal already verified"
      });
    }

    // Verify the proposal
    opportunity.verifiedProposal = true;
    opportunity.verifiedProposalAt = new Date();
    opportunity.verifiedProposalBy = userId;
    await opportunity.save();

    const clientName = opportunity.client?.name || "Client";
    const propertyName = opportunity.property?.name || "Property";

    logDataAction(req, {
      action: "data_update",
      resource: "Opportunity",
      resourceId: opportunity._id,
      entityName: `${clientName} – ${propertyName}`,
      details: {
        action: "proposal_verified",
        propertyName,
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Proposal verified successfully"
    });
  } catch (error) {
    console.error("Error verifying proposal:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify proposal",
      error: error.message || "Unknown error occurred"
    });
  }
};


